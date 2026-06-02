/**
 * WakeWordDetector — listens passively for a configurable wake phrase using
 * the browser's built-in SpeechRecognition API (available in Electron/Chromium).
 *
 * Usage:
 *   const detector = new WakeWordDetector('hey obsidian', () => startSession());
 *   detector.start();   // begin listening
 *   detector.stop();    // release mic
 */

type SpeechRecognitionCtor = new () => SpeechRecognition;

// Electron/Chromium exposes the prefixed variant; prefer the standard one.
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  return (
    (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
    (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition ??
    null
  );
}

export function isSpeechRecognitionAvailable(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

export class WakeWordDetector {
  private recognition: SpeechRecognition | null = null;
  private active = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private debug: boolean;

  /** Phrase to listen for (lowercased internally). */
  private phrase: string;
  /** Called once when the phrase is detected. Detector stops itself before calling. */
  private onDetected: () => void;

  constructor(phrase: string, onDetected: () => void, debug = false) {
    this.phrase = phrase.toLowerCase().trim();
    this.onDetected = onDetected;
    this.debug = debug;
  }

  /** Update the wake phrase without restarting. Takes effect on next restart. */
  setPhrase(phrase: string): void {
    this.phrase = phrase.toLowerCase().trim();
  }

  isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) return;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      console.warn('[WakeWord] SpeechRecognition not available in this environment.');
      return;
    }

    this.active = true;
    this.spawnRecognition(Ctor);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;

    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (this.recognition) {
      try { this.recognition.abort(); } catch { /* ignore */ }
      this.recognition = null;
    }
  }

  private spawnRecognition(Ctor: SpeechRecognitionCtor): void {
    if (!this.active) return;

    const rec = new Ctor();
    this.recognition = rec;

    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = 'en-US';
    rec.maxAlternatives = 1;

    rec.onresult = (event: SpeechRecognitionEvent) => {
      if (!this.active) return;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript.toLowerCase().trim();

        if (this.debug) {
          console.debug(`[WakeWord] transcript (${result.isFinal ? 'final' : 'interim'}): "${transcript}"`);
        }

        if (transcript.includes(this.phrase)) {
          if (this.debug) console.debug(`[WakeWord] phrase detected: "${this.phrase}"`);
          this.stop();
          this.onDetected();
          return;
        }
      }
    };

    rec.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (!this.active) return;

      // 'no-speech' and 'audio-capture' are transient — restart silently.
      // 'not-allowed' means mic permission denied — give up.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        console.warn(`[WakeWord] Mic permission denied (${event.error}). Wake word disabled.`);
        this.active = false;
        return;
      }

      if (this.debug) console.debug(`[WakeWord] Recognition error: ${event.error} — restarting in 500ms`);
      this.scheduleRestart(Ctor, 500);
    };

    rec.onend = () => {
      if (!this.active) return;
      // Continuous mode still fires onend when the browser's internal session
      // times out. Restart immediately so listening is seamless.
      if (this.debug) console.debug('[WakeWord] Recognition ended — restarting');
      this.scheduleRestart(Ctor, 100);
    };

    try {
      rec.start();
      if (this.debug) console.debug('[WakeWord] Recognition started');
    } catch (e) {
      if (this.debug) console.debug('[WakeWord] Failed to start recognition:', e);
      this.scheduleRestart(Ctor, 1000);
    }
  }

  private scheduleRestart(Ctor: SpeechRecognitionCtor, delayMs: number): void {
    if (!this.active) return;
    if (this.restartTimer !== null) return; // already scheduled

    this.recognition = null;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.active) this.spawnRecognition(Ctor);
    }, delayMs);
  }
}
