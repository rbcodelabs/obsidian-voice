# Voice — Obsidian Plugin

Talk with your documents using OpenAI's Realtime voice API. Ask questions, dictate edits, search your vault, and navigate notes — all hands-free.

## Features

- **Live voice conversation** with your current document as context
- **Wake word detection** — say "hey obsidian" to connect hands-free, no button press needed. Runs a local ONNX model entirely on-device; no audio leaves your machine.
- **Voice enrollment** — record 5 samples to calibrate the wake word to your voice and microphone (Settings → Voice → Wake Word → Calibrate)
- **Silence auto-disconnect** — automatically disconnects after configurable silence (default 15s); wake word re-arms instantly so you can reconnect hands-free
- **Document tools** the AI can use mid-conversation:
  - Read the current document
  - Append timestamped notes
  - Insert text at cursor
  - Replace document content
  - Search your vault by keyword
  - Open any note in a new tab
  - List outgoing links
- **Claude Threads integration** — if you use the Claude Threads plugin, the AI is notified when threads complete and can proactively report results mid-conversation
- **Rich sidebar transcript** — see what was said, what tools ran, and what files were touched
- **Hotkey support** — bind a key to toggle the voice connection without touching the panel
- **Context banner** — always shows which file and how many chars the AI has as context

## Requirements

- An [OpenAI API key](https://platform.openai.com/api-keys) with Realtime API access
- Obsidian 1.11.4 or later (desktop only)

## Installation via BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian community plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `rbcodelabs/obsidian-voice`
4. Enable the **Voice** plugin in Settings → Community plugins

## Setup

1. Open Settings → Voice
2. Click **Set API Key** and paste your OpenAI API key
3. Choose a voice (Marin is the default)
4. Optionally add extra system prompt instructions
5. Click the mic icon in the ribbon (or use your hotkey) to open the Voice panel
6. Open a note, then click **Connect**

### Enabling wake word (optional)

1. In Settings → Voice → **Wake Word**, toggle on **Enable wake word**
2. Click **Calibrate** and say "hey obsidian" 5 times when prompted — this tunes detection to your voice and microphone
3. Open the Voice panel — it now listens passively and connects automatically when it hears "hey obsidian"

Without calibration the default threshold (0.75) works for many users; calibration gives better accuracy in noisy environments or if you're getting false triggers.

## Usage

**Manual:** Click the mic icon in the ribbon (or use your hotkey) to open the Voice panel, then click **Connect**.

**Hands-free:** With wake word enabled, just say "hey obsidian" — the plugin connects and plays a short chime. After 15 seconds of silence (configurable) it disconnects automatically; say "hey obsidian" again to reconnect.

Once connected, just speak. The AI has your document in context and can answer questions or edit it on request. Tool actions appear as pills in the transcript so you can follow along.

To assign a hotkey: Settings → Hotkeys → search "Toggle Voice connection".

## Settings reference

| Setting | Default | Description |
|---|---|---|
| Voice | Marin | AI voice used for responses |
| Extra system prompt | — | Additional instructions appended to the base prompt |
| Enable wake word | Off | Listen for "hey obsidian" to auto-connect |
| Detection threshold | 0.75 | Confidence required to trigger (0–1). Lower = more sensitive. Calibrate sets this automatically. |
| Silence timeout | 15s | Seconds of silence before auto-disconnect (0 = disabled) |
| Debug logging | Off | Log wake word scores and session events to DevTools (Cmd+Option+I) |

## Model

Uses `gpt-realtime-2` via the OpenAI Realtime API (WebRTC).

## Release Process

Follow these steps **in order**. The golden rule: **edit versions → build → verify dist → commit → tag → release**.

### Steps

1. **Bump versions** in `manifest.json`, `package.json`, and `versions.json` (all three must match):
   ```bash
   # manifest.json  →  "version": "X.Y.Z"
   # package.json   →  "version": "X.Y.Z"
   # versions.json  →  add "X.Y.Z": "1.11.4"
   ```

2. **Build from inside the repo directory** — `esbuild.config.mjs` uses relative paths for `entryPoints` and `outfile`, so the CWD at build time determines which source files are compiled and where `dist/` is written. **Never invoke it via absolute path from a different directory.**
   ```bash
   cd /path/to/repo   # MUST cd first
   node esbuild.config.mjs
   ```

3. **Verify `dist/manifest.json` before doing anything else:**
   ```bash
   cat dist/manifest.json   # "version" must equal X.Y.Z — if not, stop and fix
   ```

4. **Commit and open a PR** (master has branch protection):
   ```bash
   git add manifest.json package.json versions.json src/...
   git commit -m "chore: bump version to vX.Y.Z"
   git push -u origin your-branch
   gh pr create && gh pr merge --squash --delete-branch
   ```

5. **Sync local to merged master, then rebuild** so `dist/` reflects the exact squash-merge commit (not the pre-merge branch state):
   ```bash
   git fetch origin master
   git reset --hard origin/master
   node esbuild.config.mjs        # run from same directory
   cat dist/manifest.json         # confirm X.Y.Z again
   ```

6. **Tag the merged commit and push:**
   ```bash
   MERGE_SHA=$(git rev-parse origin/master)
   git tag vX.Y.Z $MERGE_SHA
   git push origin vX.Y.Z
   ```

7. **Create the GitHub release** (run from the same directory as the build):
   ```bash
   gh release create vX.Y.Z \
     dist/main.js dist/manifest.json dist/styles.css \
     dist/melspectrogram.onnx dist/embedding_model.onnx \
     dist/hey_obsidian.onnx dist/ort-wasm-simd-threaded.wasm \
     --title "vX.Y.Z — description" \
     --notes "..."
   ```

8. **Verify the manifest in the release** — this is the final gate:
   ```bash
   gh release download vX.Y.Z --pattern manifest.json --output /tmp/check.json --clobber
   cat /tmp/check.json   # "version" must equal X.Y.Z — if wrong, use --clobber to re-upload
   ```
   To fix a wrong manifest after the fact: `gh release upload vX.Y.Z dist/manifest.json --clobber`

### Why the build must happen after `reset --hard`

When working in a git worktree, the branch may have diverged from what GitHub squash-merged. Steps 5–6 ensure the artifact you upload is compiled from the exact commit that is tagged — not from a local pre-merge state with a different version string.

### Why you must `cd` before running esbuild

`esbuild.config.mjs` resolves `entryPoints: ['src/main.ts']` and `outfile: 'dist/main.js'` relative to the **current working directory**, not the script's location. Invoking it as `node /abs/path/to/esbuild.config.mjs` from a different directory silently compiles the wrong source tree into the wrong `dist/`. Always `cd` into the repo first.
