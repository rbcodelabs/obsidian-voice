#!/usr/bin/env node
/**
 * debug-realtime.mjs — OpenAI Realtime API event timeline debugger
 *
 * Connects via WebSocket, sends a text prompt, logs every event with timing.
 * Key goal: understand the exact sequence and timing of response.output_audio.done
 * vs response.done, and how much audio is still buffered when each fires.
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... node debug-realtime.mjs
 *   OPENAI_API_KEY=sk-... node debug-realtime.mjs "What is 2 + 2?"
 *   node debug-realtime.mjs            # reads OPENAI_API_KEY from .env if present
 */

import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';   // npm ws — supports headers in WebSocket upgrade

// ── Config ──────────────────────────────────────────────────────────────────

// Load .env from script directory if present
const envPath = path.join(import.meta.dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

const API_KEY = process.env.OPENAI_API_KEY;
const MODEL   = process.env.REALTIME_MODEL ?? 'gpt-realtime-2';
const PROMPT  = process.argv[2] ?? 'Say exactly five words: one two three four five.';
const VOICE   = 'alloy';

// PCM16 24 kHz mono = 48 000 bytes/sec
const BYTES_PER_SEC = 48_000;

if (!API_KEY) {
  console.error('❌  OPENAI_API_KEY env var required (or put it in .env next to this script)');
  process.exit(1);
}

// ── Timing helpers ───────────────────────────────────────────────────────────

const T0 = Date.now();
let tLast = T0;

function ts() {
  const ms = Date.now() - T0;
  return `+${(ms / 1000).toFixed(3)}s`;
}

function gap() {
  const ms = Date.now() - tLast;
  tLast = Date.now();
  return ms >= 5 ? `  Δ${ms}ms` : '';
}

// ── State machine (mirrors RealtimeSession.ts logic) ─────────────────────────

const sm = {
  isResponseActive: false,
  pendingToolCalls: 0,
  notificationCancelPending: false,
  notificationQueueLen: 0,
  pendingResponseRetry: false,
  audioDoneFired: false,
  totalAudioBytes: 0,
  audioDeltaCount: 0,
  responseStartTime: 0,
  audioDoneTime: null,
  responseDoneTime: null,
};

function smStr() {
  return [
    `responseActive=${sm.isResponseActive}`,
    `tools=${sm.pendingToolCalls}`,
    `audioDoneFired=${sm.audioDoneFired}`,
  ].join(' ');
}

function estimatedAudioMs() {
  return Math.round((sm.totalAudioBytes / BYTES_PER_SEC) * 1000);
}

function analyzeIdlePath() {
  const now = Date.now();
  const estPlayMs = estimatedAudioMs();
  const responseAge = now - sm.responseStartTime;

  console.log();
  console.log('  ┌─ IDLE PATH ANALYSIS ─────────────────────────────────────────────');
  console.log(`  │  Audio received: ${sm.totalAudioBytes.toLocaleString()} bytes across ${sm.audioDeltaCount} deltas`);
  console.log(`  │  Estimated audio duration: ${estPlayMs}ms (${(estPlayMs/1000).toFixed(2)}s)`);
  console.log(`  │  Time since response.created: ${responseAge}ms`);
  if (sm.audioDoneTime) {
    const playbackLeft = Math.max(0, sm.audioDoneTime + estPlayMs - now);
    console.log(`  │  response.output_audio.done fired ${now - sm.audioDoneTime}ms ago`);
    console.log(`  │  Estimated audio still playing: ${playbackLeft}ms`);
  }
  console.log('  │');

  if (sm.pendingToolCalls > 0) {
    console.log(`  │  → Would flush tool batch (${sm.pendingToolCalls} calls) — no onAudioDone`);
  } else if (sm.notificationCancelPending || sm.notificationQueueLen > 0) {
    console.log(`  │  → Would drain notification queue — no onAudioDone`);
  } else if (sm.pendingResponseRetry) {
    console.log(`  │  → Would retry response.create — no onAudioDone`);
  } else {
    const alreadyFired = sm.audioDoneFired;
    console.log(`  │  → WOULD FIRE waitForAudioSilence() ${alreadyFired ? '(already started from output_audio.done!)' : '← first call'}`);
    if (!alreadyFired) {
      if (sm.audioDoneTime === null) {
        console.log(`  │  ⚠️  response.output_audio.done never fired — this is the only trigger`);
        console.log(`  │  ⚠️  Audio may still be playing (est. ${estPlayMs}ms of audio received)`);
      } else {
        const lag = now - sm.audioDoneTime;
        console.log(`  │  ℹ️  response.output_audio.done fired ${lag}ms ago`);
      }
    }
  }
  console.log('  └──────────────────────────────────────────────────────────────────');
  console.log();
}

// ── Icon map ─────────────────────────────────────────────────────────────────

const ICONS = {
  'session.created':    '🟢',
  'session.updated':    '⚙️ ',
  'response.created':   '▶️ ',
  // GA API event names (gpt-realtime-2)
  'response.output_audio.delta':              '🔊',
  'response.output_audio.done':               '🔇',
  'response.output_audio_transcript.delta':   '📝',
  'response.output_audio_transcript.done':    '📄',
  // Legacy beta event names (kept for reference)
  'response.audio.delta':            '🔊',
  'response.audio.done':             '🔇',
  'response.audio_transcript.delta': '📝',
  'response.audio_transcript.done':  '📄',
  'response.output_item.added': '📦',
  'response.output_item.done':  '📦',
  'response.content_part.done': '✅',
  'response.done':      '🏁',
  'conversation.item.created': '💾',
  'conversation.item.input_audio_transcription.completed': '🎤',
  'input_audio_buffer.speech_started': '🗣 ',
  'input_audio_buffer.speech_stopped': '🤫',
  'error':              '❌',
};

// ── Main ─────────────────────────────────────────────────────────────────────

console.log();
console.log('🎙  OpenAI Realtime API — Event Timeline Debugger');
console.log(`    Model : ${MODEL}`);
console.log(`    Voice : ${VOICE}`);
console.log(`    Prompt: "${PROMPT}"`);
console.log();

const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, {
  headers: {
    Authorization: `Bearer ${API_KEY}`,
  },
});

ws.on('open', () => {
  console.log(`${ts()} ✅  WebSocket open\n`);
});

ws.on('message', (data) => {
  let ev;
  try { ev = JSON.parse(data.toString()); } catch { return; }

  const type = ev.type ?? 'unknown';
  const g = gap();

  // ── Audio delta: count silently, log milestones ──────────────────────────
  if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
    sm.audioDeltaCount++;
    const bytes = Math.round((ev.delta?.length ?? 0) * 0.75); // base64 → bytes
    sm.totalAudioBytes += bytes;

    const first = sm.audioDeltaCount === 1;
    const every = sm.audioDeltaCount % 10 === 0;
    if (first || every) {
      const estMs = estimatedAudioMs();
      console.log(
        `${ts()}${g}  ${ICONS[type]} response.audio.delta` +
        ` [#${sm.audioDeltaCount}]  total ${sm.totalAudioBytes.toLocaleString()}B ≈ ${estMs}ms audio`
      );
    }
    return;
  }

  // ── All other events: log with icon ──────────────────────────────────────
  const icon = ICONS[type] ?? '   ';
  console.log(`${ts()}${g}  ${icon} ${type}`);

  // ── Per-event handling ────────────────────────────────────────────────────

  switch (type) {

    case 'session.created':
      // Send session config then our text prompt
      console.log(`       → configuring session + sending prompt`);
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: 'You are a test assistant. Be extremely brief — one sentence max.',
          tool_choice: 'none',
        },
      }));
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: PROMPT }],
        },
      }));
      ws.send(JSON.stringify({ type: 'response.create' }));
      break;

    case 'response.created':
      sm.isResponseActive = true;
      sm.audioDoneFired = false;
      sm.totalAudioBytes = 0;
      sm.audioDeltaCount = 0;
      sm.audioDoneTime = null;
      sm.responseDoneTime = null;
      sm.responseStartTime = Date.now();
      console.log(`       [${smStr()}]`);
      break;

    case 'response.output_audio.done':
    case 'response.audio.done': {
      sm.audioDoneTime = Date.now();
      const estMs = estimatedAudioMs();
      console.log(`       Audio bytes: ${sm.totalAudioBytes.toLocaleString()}B across ${sm.audioDeltaCount} deltas`);
      console.log(`       Estimated audio duration: ${estMs}ms (${(estMs/1000).toFixed(2)}s)`);
      console.log(`       ↳ Current impl fires onAudioDone() HERE`);
      console.log(`       ↳ But if buffered audio still playing, countdown starts too early!`);
      sm.audioDoneFired = true;
      break;
    }

    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
      console.log(`       Transcript: "${ev.transcript}"`);
      break;

    case 'response.done': {
      sm.isResponseActive = false;
      sm.responseDoneTime = Date.now();
      const estMs = estimatedAudioMs();
      console.log(`       Audio received: ${sm.totalAudioBytes.toLocaleString()}B ≈ ${estMs}ms`);
      analyzeIdlePath();

      // Wait to see if any late events arrive, then summarize and exit
      console.log(`\n       Waiting 4s for any late-arriving events…\n`);
      setTimeout(() => {
        const totalMs = Date.now() - T0;
        const estPlay = estimatedAudioMs();
        console.log('═'.repeat(66));
        console.log('📊  SESSION SUMMARY');
        console.log('═'.repeat(66));
        console.log(`  Total session time    : ${totalMs}ms`);
        console.log(`  Audio received        : ${sm.totalAudioBytes.toLocaleString()} bytes in ${sm.audioDeltaCount} deltas`);
        console.log(`  Estimated audio length: ${estPlay}ms (${(estPlay/1000).toFixed(2)}s)`);
        console.log(`  response.output_audio.done : ${sm.audioDoneTime ? `fired at T+${sm.audioDoneTime - T0}ms` : '❌ NEVER FIRED'}`);
        console.log(`  response.done              : fired at T+${sm.responseDoneTime - T0}ms`);
        if (sm.audioDoneTime && sm.responseDoneTime) {
          const diff = sm.responseDoneTime - sm.audioDoneTime;
          console.log(`  output_audio.done → done gap : ${diff}ms ${diff > 0 ? '(output_audio.done first)' : '(done first!)'}`);
        }
        console.log();
        console.log('🔑  DIAGNOSIS:');
        if (!sm.audioDoneTime) {
          console.log('  response.output_audio.done never fired in this session.');
          console.log('  The idle-path in response.done is the only trigger for waitForAudioSilence.');
          console.log(`  response.done fires while ~${estPlay}ms of audio may still be buffered.`);
          console.log('  → waitForAudioSilence() polls the <audio> element; onAudioDone fires on actual silence.');
        } else {
          const lag = sm.audioDoneTime - sm.responseStartTime;
          console.log(`  response.output_audio.done fired ${lag}ms after response.created.`);
          console.log(`  At that point, ${estPlay}ms of audio was received — may still be buffered.`);
          console.log('  → waitForAudioSilence() detects actual playback end; onAudioDone fires on silence.');
        }
        console.log('═'.repeat(66));
        ws.close();
        process.exit(0);
      }, 4000);
      break;
    }

    case 'error':
      console.log(`       ${JSON.stringify(ev.error)}`);
      break;
  }
});

ws.on('error', (e) => {
  console.error(`${ts()} ❌  WebSocket error:`, e.message ?? e);
  process.exit(1);
});

ws.on('close', (code, reason) => {
  console.log(`\n${ts()} 🔌  WebSocket closed (${code}): ${reason?.toString() ?? 'no reason'}`);
});
