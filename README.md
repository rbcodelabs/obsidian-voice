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

Follow these steps **in order**. Version files must be updated and committed **before** building — the artifacts uploaded to GitHub are snapshots of the files at build/upload time.

1. **Bump versions first** (both files must match the new version):
   ```bash
   # Edit manifest.json  →  "version": "X.Y.Z"
   # Edit package.json   →  "version": "X.Y.Z"
   ```

2. **Build** so the compiled output is based on the new version:
   ```bash
   npm run build
   ```

3. **Commit the version bump**:
   ```bash
   git add manifest.json package.json
   git commit -m "chore: bump version to vX.Y.Z"
   ```

4. **Merge to master and push the tag**:
   ```bash
   git checkout master
   git merge --ff-only <release-branch>
   git tag vX.Y.Z
   git push origin master --tags
   ```

5. **Create the GitHub release from the same directory where you built** — `dist/` in the main checkout is often stale from an older build:
   ```bash
   # Run this from the worktree where npm run build was executed
   gh release create vX.Y.Z dist/main.js dist/manifest.json dist/styles.css \
     --title "vX.Y.Z" \
     --notes "Brief description of changes"
   ```

6. **Verify** the manifest version in the release matches the tag:
   ```bash
   gh release download vX.Y.Z --pattern manifest.json --output /tmp/check.json --clobber
   cat /tmp/check.json   # "version" must equal X.Y.Z
   ```

> **Common mistakes:**
> - Editing `manifest.json` *after* the build causes the old version to be uploaded. Always edit → build → commit → release.
> - Running `gh release create` from the main checkout (not the build worktree) uploads a stale `dist/` with an old version. Always run from the directory where `npm run build` was executed.
