import { Modal, App } from 'obsidian';
import type VoicePlugin from './main';
import { WakeWordDetector } from './WakeWordDetector';

const NUM_SAMPLES = 5;
const COUNTDOWN_SECS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class EnrollmentModal extends Modal {
  private plugin: VoicePlugin;
  private detector: WakeWordDetector | null = null;
  private aborted = false;
  private scores: number[] = [];
  private embeddings: Float32Array[] = [];

  constructor(app: App, plugin: VoicePlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.titleEl.textContent = 'Calibrate wake word to your voice';
    this.renderIntro();
  }

  onClose(): void {
    this.aborted = true;
    this.detector?.stopEnrollment();
    this.detector = null;
    this.plugin.resumeWakeDetector();
  }

  private renderIntro(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', {
      text: 'We\'ll record you saying "hey obsidian" 5 times to calibrate detection to your voice and microphone.',
    });
    contentEl.createEl('p', {
      text: 'Speak naturally at a normal volume. Takes about 30 seconds.',
      cls: 'setting-item-description',
    });
    contentEl.createEl('button', { text: 'Start calibration', cls: 'mod-cta' })
      .addEventListener('click', () => void this.runEnrollment());
  }

  private async runEnrollment(): Promise<void> {
    this.scores = [];
    this.embeddings = [];
    this.aborted = false;

    // Pause the always-on detector so it doesn't fire mid-enrollment
    this.plugin.suspendWakeDetector();

    const adapter = this.plugin.app.vault.adapter as { basePath?: string };
    const modelDir = adapter.basePath && this.plugin.manifest.dir
      ? `${adapter.basePath}/${this.plugin.manifest.dir}`
      : (this.plugin.manifest.dir ?? '');

    this.detector = new WakeWordDetector(
      modelDir,
      () => { /* no-op — enrollment doesn't trigger connection */ },
      this.plugin.settings.debugLogging,
    );

    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('p', { text: 'Starting microphone and loading models…', cls: 'voice-enroll-loading' });

    try {
      await this.detector.startEnrollment();
    } catch (err) {
      contentEl.empty();
      contentEl.createEl('p', { text: `Could not access microphone: ${err}`, cls: 'voice-enroll-error' });
      return;
    }

    if (this.aborted) return;

    contentEl.empty();
    const currentEl = contentEl.createDiv({ cls: 'voice-enroll-current' });
    const resultsEl = contentEl.createDiv({ cls: 'voice-enroll-results' });

    for (let i = 0; i < NUM_SAMPLES; i++) {
      if (this.aborted) return;

      await this.showCountdown(currentEl, i + 1);
      if (this.aborted) return;

      this.showRecording(currentEl);

      let result: { score: number; embedding: Float32Array };
      try {
        result = await this.detector.captureEnrollmentSample();
      } catch (err) {
        currentEl.empty();
        currentEl.createEl('p', { text: `Recording failed: ${err}`, cls: 'voice-enroll-error' });
        return;
      }

      this.scores.push(result.score);
      this.embeddings.push(result.embedding);
      this.addResultRow(resultsEl, i + 1, result.score);
      currentEl.empty();

      if (i < NUM_SAMPLES - 1) await sleep(700);
    }

    this.detector.stopEnrollment();
    this.detector = null;

    if (!this.aborted) this.renderSummary(contentEl);
  }

  private async showCountdown(el: HTMLElement, sampleNum: number): Promise<void> {
    el.empty();
    el.createEl('div', { cls: 'voice-enroll-label', text: `Sample ${sampleNum} of ${NUM_SAMPLES}` });
    const countEl = el.createEl('div', { cls: 'voice-enroll-counter' });
    const hintEl = el.createEl('p', { text: 'Get ready…', cls: 'voice-enroll-hint' });

    for (let s = COUNTDOWN_SECS; s >= 1; s--) {
      if (this.aborted) return;
      countEl.textContent = String(s);
      await sleep(1000);
    }
    countEl.textContent = '🎙️';
    hintEl.textContent = 'Say "hey obsidian" now!';
  }

  private showRecording(el: HTMLElement): void {
    const countEl = el.querySelector('.voice-enroll-counter');
    const hintEl = el.querySelector('.voice-enroll-hint');
    if (countEl) countEl.textContent = '⏺';
    if (hintEl) (hintEl as HTMLElement).textContent = 'Recording…';
  }

  private addResultRow(container: HTMLElement, sampleNum: number, score: number): void {
    const row = container.createDiv({ cls: 'voice-enroll-row' });
    row.createSpan({ text: `${sampleNum}`, cls: 'voice-enroll-row-num' });

    const bar = row.createDiv({ cls: 'voice-enroll-bar' });
    const fill = bar.createDiv({ cls: 'voice-enroll-bar-fill' });
    fill.style.width = `${Math.round(score * 100)}%`;
    fill.addClass(
      score >= 0.6 ? 'voice-enroll-bar--good'
      : score >= 0.35 ? 'voice-enroll-bar--ok'
      : 'voice-enroll-bar--poor'
    );

    row.createSpan({ text: score.toFixed(3), cls: 'voice-enroll-score-val' });
    row.createSpan({
      text: score >= 0.6 ? '✓' : score >= 0.35 ? '~' : '✗',
      cls: score >= 0.6 ? 'voice-enroll-check--good' : 'voice-enroll-check--warn',
    });
  }

  private renderSummary(contentEl: HTMLElement): void {
    const minScore = Math.min(...this.scores);
    const recommended = parseFloat(Math.max(0.25, minScore * 0.9).toFixed(2));

    const summaryEl = contentEl.createDiv({ cls: 'voice-enroll-summary' });

    summaryEl.createEl('p', {
      text: `Recommended threshold: ${recommended}  (your lowest score: ${minScore.toFixed(3)})`,
      cls: 'voice-enroll-summary-line',
    });

    if (minScore < 0.35) {
      summaryEl.createEl('p', {
        text: '⚠️ Some scores were very low. Try in a quieter spot, or check your microphone.',
        cls: 'voice-enroll-warning',
      });
    }

    summaryEl.createEl('p', {
      text: 'Top 3 samples will also be saved as voice templates for pattern matching.',
      cls: 'setting-item-description',
    });

    // Store top-3 embeddings by score
    const top3 = [...this.scores.map((s, i) => ({ s, i }))]
      .sort((a, b) => b.s - a.s)
      .slice(0, 3)
      .map(({ i }) => Array.from(this.embeddings[i]));

    const btnRow = summaryEl.createDiv({ cls: 'voice-enroll-btn-row' });

    btnRow.createEl('button', { text: 'Save calibration', cls: 'mod-cta' })
      .addEventListener('click', async () => {
        this.plugin.settings.wakeWordThreshold = recommended;
        this.plugin.settings.enrollmentEmbeddings = top3;
        await this.plugin.saveSettings();
        this.close(); // onClose() calls resumeWakeDetector() + applyWakeWordSetting()
      });

    btnRow.createEl('button', { text: 'Try again' })
      .addEventListener('click', () => void this.runEnrollment());

    btnRow.createEl('button', { text: 'Cancel' })
      .addEventListener('click', () => this.close());
  }
}
