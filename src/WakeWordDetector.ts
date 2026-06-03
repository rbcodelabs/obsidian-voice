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
// 0.94 is the training-set optimum (recall 91.3%, FPPH 0.12), but real-world
// microphone/room variation typically pushes peak scores lower.  0.75 is a
// better default starting point; tune upward if false-positives are frequent.
const DEFAULT_THRESHOLD = 0.75;

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

  /**
   * Start audio + load models without entering the inference loop.
   * Call before captureEnrollmentSample(). Safe to call if already started.
   */
  async startEnrollment(): Promise<void> {
    await this.ensureModels();
    if (!this.audioCtx) await this.startAudio();
  }

  /**
   * Stop audio capture started by startEnrollment().
   * Does NOT touch this.active — safe to call independently of start()/stop().
   */
  stopEnrollment(): void {
    if (this.inferenceTimer) { clearInterval(this.inferenceTimer); this.inferenceTimer = null; }
    this.workletNode?.disconnect(); this.workletNode = null;
    if (this.mediaStream) { this.mediaStream.getTracks().forEach(t => t.stop()); this.mediaStream = null; }
    if (this.audioCtx) { this.audioCtx.close(); this.audioCtx = null; }
  }

  /**
   * Listen for up to `windowMs` milliseconds, run inference every `intervalMs`,
   * and return the PEAK classifier score plus the embedding from that best frame.
   * Call startEnrollment() first.
   *
   * Rolling inference matches how the live detector works: the classifier scores
   * highest when the phrase sits at the TAIL of the 2.2 s buffer (i.e. the user
   * just finished speaking).  A single end-of-window snapshot misses this peak
   * if the user spoke near the start of the window — producing near-zero scores.
   */
  async captureEnrollmentSample(
    windowMs = 3000,
    intervalMs = 200,
  ): Promise<{ score: number; embedding: Float32Array }> {
    // Wait until the circular buffer has accumulated at least one full window
    while (this.samplesWritten < BUFFER_SIZE && this.audioCtx !== null) {
      await new Promise<void>(r => setTimeout(r, 50));
    }

    let bestScore = 0;
    let bestEmbedding = new Float32Array(96);
    const deadline = Date.now() + windowMs;

    while (Date.now() < deadline && this.audioCtx !== null) {
      // Unwrap circular buffer oldest → newest
      const audio = new Float32Array(BUFFER_SIZE);
      const head = this.bufferHead;
      for (let i = 0; i < BUFFER_SIZE; i++) audio[i] = this.buffer[(head + i) % BUFFER_SIZE];

      const melFrames = await this.runMel(audio);
      const embeddings = await this.runEmbeddings(melFrames);

      if (embeddings.length >= MIN_EMBEDDINGS) {
        const score = await this.runClassifier(embeddings);
        if (this.debug) console.log(`[WakeWord] enroll poll: score=${score.toFixed(3)} best=${bestScore.toFixed(3)}`);
        if (score > bestScore) {
          bestScore = score;
          bestEmbedding = this.averageEmbeddings(embeddings.slice(-MIN_EMBEDDINGS));
        }
      }

      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise<void>(r => setTimeout(r, Math.min(intervalMs, remaining)));
    }

    return { score: bestScore, embedding: bestEmbedding };
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
    ort.env.wasm.numThreads = 1;  // single-threaded — avoids SharedArrayBuffer requirement
    (ort.env.wasm as any).proxy = false; // no proxy worker needed in single-threaded mode

    // Obsidian's Electron renderer blocks BOTH file:// resource loads AND
    // dynamic import() of local paths.  Work around this by loading both
    // WASM assets from disk via Node.js fs and serving them through channels
    // that Electron always permits:
    //
    //  • ort-wasm-simd-threaded.mjs  (Emscripten JS glue, ~24 KB)
    //      → read as text, wrap in a Blob, expose as a blob: URL.
    //        ort uses wasmPaths.mjs as the target of its dynamic import().
    //        blob: URLs are never blocked by Electron's local-resource policy.
    //
    //  • ort-wasm-simd-threaded.wasm (~12 MB)
    //      → read as bytes, set on wasmBinary.
    //        ort skips fetch() entirely when wasmBinary is pre-populated.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');

    const mjsText = fs.readFileSync(`${this.modelDir}/ort-wasm-simd-threaded.mjs`, 'utf8');
    const mjsBlobUrl = URL.createObjectURL(
      new Blob([mjsText], { type: 'application/javascript' }),
    );

    const wasmBuf = fs.readFileSync(`${this.modelDir}/ort-wasm-simd-threaded.wasm`);
    ort.env.wasm.wasmBinary = new Uint8Array(wasmBuf.buffer, wasmBuf.byteOffset, wasmBuf.byteLength);

    // wasmPaths.mjs → the dynamic import() target for the Emscripten glue.
    (ort.env.wasm as any).wasmPaths = { mjs: mjsBlobUrl };

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

    // Verify the context actually runs at 16 kHz — if the OS/hardware ignores
    // the request the mel spectrogram model will receive wrong-rate audio and
    // all scores will be near-zero.
    if (this.audioCtx.sampleRate !== SAMPLE_RATE) {
      console.warn(
        `[WakeWord] AudioContext sample rate is ${this.audioCtx.sampleRate} Hz, ` +
        `expected ${SAMPLE_RATE} Hz — wake word accuracy will be severely degraded.`
      );
    } else if (this.debug) {
      console.log(`[WakeWord] AudioContext sample rate: ${this.audioCtx.sampleRate} Hz ✓`);
    }

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
      if (this.debug) console.log(`[WakeWord] classifier=${score.toFixed(3)} threshold=${this.threshold}`);
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

  /** Unwrap circular buffer and run all three ONNX stages. Returns classifier score. */
  private async scoreBuffer(): Promise<number> {
    const audio = new Float32Array(BUFFER_SIZE);
    const start = this.bufferHead; // oldest sample
    for (let i = 0; i < BUFFER_SIZE; i++) {
      audio[i] = this.buffer[(start + i) % BUFFER_SIZE];
    }

    const melFrames = await this.runMel(audio);
    if (this.debug) {
      console.log(`[WakeWord] mel frames: ${melFrames.length} (need ≥${MEL_FRAME_WINDOW})`);
    }
    if (melFrames.length < MEL_FRAME_WINDOW) return 0;

    const embeddings = await this.runEmbeddings(melFrames);
    if (this.debug) {
      console.log(`[WakeWord] embeddings: ${embeddings.length} (need ≥${MIN_EMBEDDINGS})`);
    }
    if (embeddings.length < MIN_EMBEDDINGS) return 0;

    return this.runClassifier(embeddings);
  }

  // ── Embedding helpers ───────────────────────────────────────────────────

  private averageEmbeddings(embeddings: Float32Array[]): Float32Array {
    const avg = new Float32Array(96);
    if (embeddings.length === 0) return avg;
    for (const e of embeddings) for (let i = 0; i < 96; i++) avg[i] += e[i];
    for (let i = 0; i < 96; i++) avg[i] /= embeddings.length;
    return avg;
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
