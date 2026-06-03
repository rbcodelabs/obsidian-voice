/**
 * WakeWordDetector — listens passively for "hey obsidian" using a 3-stage ONNX pipeline:
 *   Stage 1: melspectrogram.onnx — raw 16 kHz PCM → mel spectrogram (32 bands)
 *   Stage 2: embedding_model.onnx — 76-frame mel windows → 96-dim Google speech embeddings
 *   Stage 3: hey_obsidian.onnx — sequence of 16 embeddings → confidence score
 *
 * The model was trained locally with livekit-wakeword (openWakeWord architecture).
 * Optimal threshold: 0.94 → FPPH=0.12, Recall=91.3% on held-out validation set.
 *
 * Audio pipeline:
 *   getUserMedia (16 kHz mono) → AudioWorklet → 2.2 s circular buffer
 *   → ONNX inference every 500 ms → callback on score ≥ threshold
 */

import * as ort from 'onnxruntime-web';

// ── constants matching the Python training pipeline ────────────────────────
const SAMPLE_RATE = 16000;
const BUFFER_SECONDS = 2.2;
const BUFFER_SIZE = Math.ceil(SAMPLE_RATE * BUFFER_SECONDS); // ~35 200 samples
const MEL_FRAME_WINDOW = 76;    // mel frames per embedding window
const EMBEDDING_STRIDE = 8;     // hop between embedding windows
const MIN_EMBEDDINGS = 16;      // classifier input length
const INFERENCE_INTERVAL_MS = 500;
const DEFAULT_THRESHOLD = 0.94; // optimal threshold from training eval

export class WakeWordDetector {
  private active = false;
  private debug: boolean;
  private threshold: number;
  private onDetected: () => void;
  private modelDir: string;

  // Audio infrastructure
  private audioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private inferenceTimer: ReturnType<typeof setInterval> | null = null;
  private inferenceRunning = false;

  // Circular sample buffer
  private readonly buffer = new Float32Array(BUFFER_SIZE);
  private bufferHead = 0;
  private samplesWritten = 0;

  // ONNX inference sessions (lazy-loaded once, then reused across start/stop cycles)
  private melSession: ort.InferenceSession | null = null;
  private embSession: ort.InferenceSession | null = null;
  private clsSession: ort.InferenceSession | null = null;
  private modelsLoaded = false;
  private modelLoadPromise: Promise<void> | null = null;

  /**
   * @param modelDir   Absolute filesystem path to the directory that contains
   *                   melspectrogram.onnx, embedding_model.onnx, hey_obsidian.onnx,
   *                   and ort-wasm-simd-threaded.wasm.
   * @param onDetected Called once when the wake phrase is detected; the detector
   *                   stops itself before invoking this callback.
   * @param debug      Log inference scores and state transitions to console.
   * @param threshold  Classifier confidence threshold (default 0.94).
   */
  constructor(
    modelDir: string,
    onDetected: () => void,
    debug = false,
    threshold = DEFAULT_THRESHOLD,
  ) {
    this.modelDir = modelDir;
    this.onDetected = onDetected;
    this.debug = debug;
    this.threshold = threshold;
  }

  isActive(): boolean {
    return this.active;
  }

  /** Start listening. Fires async internally; returns immediately. */
  start(): void {
    if (this.active) return;
    this.active = true;
    void this.startAsync();
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.inferenceTimer) {
      clearInterval(this.inferenceTimer);
      this.inferenceTimer = null;
    }
    if (this.workletNode) {
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop();
      this.mediaStream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    if (this.debug) console.log('[WakeWord] stopped');
  }

  // ── private ────────────────────────────────────────────────────────────

  private async startAsync(): Promise<void> {
    try {
      await this.ensureModels();
      await this.startAudio();
      this.inferenceTimer = setInterval(
        () => void this.runInference(),
        INFERENCE_INTERVAL_MS,
      );
      if (this.debug) console.log('[WakeWord] listening (threshold=', this.threshold, ')');
    } catch (err) {
      console.error('[WakeWord] failed to start:', err);
      this.active = false;
    }
  }

  // ── model loading ───────────────────────────────────────────────────────

  private ensureModels(): Promise<void> {
    if (this.modelsLoaded) return Promise.resolve();
    if (!this.modelLoadPromise) this.modelLoadPromise = this.loadModels();
    return this.modelLoadPromise;
  }

  private async loadModels(): Promise<void> {
    ort.env.wasm.numThreads = 1; // single-threaded avoids SharedArrayBuffer requirement

    // Load the WASM binary from disk and hand it directly to ort, bypassing
    // any fetch() call. This is the most reliable approach in Electron where
    // file:// fetch may be restricted depending on security settings.
    const wasmBuf = await this.readFile(`${this.modelDir}/ort-wasm-simd-threaded.wasm`);
    ort.env.wasm.wasmBinary = new Uint8Array(wasmBuf);

    if (this.debug) console.log('[WakeWord] loading ONNX models from', this.modelDir);

    const [melBuf, embBuf, clsBuf] = await Promise.all([
      this.readFile(`${this.modelDir}/melspectrogram.onnx`),
      this.readFile(`${this.modelDir}/embedding_model.onnx`),
      this.readFile(`${this.modelDir}/hey_obsidian.onnx`),
    ]);

    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
    };

    [this.melSession, this.embSession, this.clsSession] = await Promise.all([
      ort.InferenceSession.create(melBuf, opts),
      ort.InferenceSession.create(embBuf, opts),
      ort.InferenceSession.create(clsBuf, opts),
    ]);

    this.modelsLoaded = true;
    if (this.debug) console.log('[WakeWord] models ready');
  }

  /** Read a file from the local filesystem via Node.js fs (available in Electron). */
  private readFile(absPath: string): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs') as typeof import('fs');
        const buf = fs.readFileSync(absPath);
        resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      } catch (err) {
        reject(new Error(`Could not read model file: ${absPath} — ${err}`));
      }
    });
  }

  // ── audio capture ───────────────────────────────────────────────────────

  private async startAudio(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    this.audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });

    // Unique name per instance to avoid "already registered" errors on re-start.
    const processorName = `wake-pcm-${Date.now()}`;
    const workletSrc = `
class _PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch?.length) this.port.postMessage(ch);
    return true;
  }
}
registerProcessor('${processorName}', _PCMCapture);
`;
    const blob = new Blob([workletSrc], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this.audioCtx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    const source = this.audioCtx.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioCtx, processorName);
    this.workletNode.port.onmessage = (evt: MessageEvent<Float32Array>) => {
      this.appendSamples(evt.data);
    };
    // Capture only — do NOT connect to destination.
    source.connect(this.workletNode);
  }

  private appendSamples(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.buffer[this.bufferHead] = chunk[i];
      this.bufferHead = (this.bufferHead + 1) % BUFFER_SIZE;
    }
    this.samplesWritten += chunk.length;
  }

  // ── inference ───────────────────────────────────────────────────────────

  private async runInference(): Promise<void> {
    if (!this.active || !this.modelsLoaded) return;
    if (this.inferenceRunning) return;
    if (this.samplesWritten < BUFFER_SIZE) return; // wait until buffer is full

    this.inferenceRunning = true;
    try {
      const score = await this.scoreBuffer();
      if (this.debug) {
        console.log(`[WakeWord] score=${score.toFixed(3)} threshold=${this.threshold}`);
      }
      if (score >= this.threshold) {
        if (this.debug) console.log('[WakeWord] detected!');
        this.stop();
        this.onDetected();
      }
    } catch (err) {
      if (this.debug) console.error('[WakeWord] inference error:', err);
    } finally {
      this.inferenceRunning = false;
    }
  }

  /** Unwrap circular buffer and run all three ONNX stages. */
  private async scoreBuffer(): Promise<number> {
    const audio = new Float32Array(BUFFER_SIZE);
    const start = this.bufferHead; // oldest sample
    for (let i = 0; i < BUFFER_SIZE; i++) {
      audio[i] = this.buffer[(start + i) % BUFFER_SIZE];
    }

    const melFrames = await this.runMel(audio);
    if (melFrames.length < MEL_FRAME_WINDOW) return 0;

    const embeddings = await this.runEmbeddings(melFrames);
    if (embeddings.length < MIN_EMBEDDINGS) return 0;

    return this.runClassifier(embeddings);
  }

  // ── Stage 1: Mel spectrogram ────────────────────────────────────────────

  private async runMel(audio: Float32Array): Promise<Float32Array[]> {
    const inputName = this.melSession!.inputNames[0];
    const tensor = new ort.Tensor('float32', audio, [1, audio.length]);
    const out = await this.melSession!.run({ [inputName]: tensor });
    const result = out[this.melSession!.outputNames[0]];
    const data = result.data as Float32Array;
    const dims = result.dims as number[];

    // Model output: (1, time_frames, 32)  OR  (1, 1, time_frames, 32)
    const timeFrames = dims.length === 4 ? dims[2] : dims[1];
    const nMels = 32;

    // Post-process: x/10 + 2  (matches openWakeWord melspec_transform)
    const mel = new Float32Array(timeFrames * nMels);
    for (let i = 0; i < mel.length; i++) {
      mel[i] = data[i] / 10.0 + 2.0;
    }

    const frames: Float32Array[] = new Array(timeFrames);
    for (let t = 0; t < timeFrames; t++) {
      frames[t] = mel.subarray(t * nMels, (t + 1) * nMels);
    }
    return frames;
  }

  // ── Stage 2: Google speech embeddings ──────────────────────────────────

  private async runEmbeddings(mel: Float32Array[]): Promise<Float32Array[]> {
    const nFrames = mel.length;
    const inputName = this.embSession!.inputNames[0];
    const outputName = this.embSession!.outputNames[0];
    const embeddings: Float32Array[] = [];

    for (
      let start = 0;
      start + MEL_FRAME_WINDOW <= nFrames;
      start += EMBEDDING_STRIDE
    ) {
      // Build (1, 76, 32, 1) tensor — channels-last format required by this model
      const windowData = new Float32Array(MEL_FRAME_WINDOW * 32);
      for (let f = 0; f < MEL_FRAME_WINDOW; f++) {
        windowData.set(mel[start + f], f * 32);
      }
      const tensor = new ort.Tensor('float32', windowData, [1, MEL_FRAME_WINDOW, 32, 1]);
      const out = await this.embSession!.run({ [inputName]: tensor });
      const raw = out[outputName].data as Float32Array;
      // Output: (1, 1, 1, 96) — grab first 96 floats
      embeddings.push(raw.slice(0, 96));
    }

    return embeddings;
  }

  // ── Stage 3: Wake word classifier ──────────────────────────────────────

  private async runClassifier(embeddings: Float32Array[]): Promise<number> {
    const last16 = embeddings.slice(-MIN_EMBEDDINGS);
    const flat = new Float32Array(MIN_EMBEDDINGS * 96);
    for (let i = 0; i < last16.length; i++) {
      flat.set(last16[i], i * 96);
    }
    const inputName = this.clsSession!.inputNames[0];
    const outputName = this.clsSession!.outputNames[0];
    const tensor = new ort.Tensor('float32', flat, [1, MIN_EMBEDDINGS, 96]);
    const out = await this.clsSession!.run({ [inputName]: tensor });
    return (out[outputName].data as Float32Array)[0];
  }
}

/** True if the environment supports microphone capture. */
export function isWakeWordAvailable(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}
