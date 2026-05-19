# Voice — Obsidian Plugin

Talk with your documents using OpenAI's Realtime voice API. Ask questions, dictate edits, search your vault, and navigate notes — all hands-free.

## Features

- **Live voice conversation** with your current document as context
- **Document tools** the AI can use mid-conversation:
  - Read the current document
  - Append timestamped notes
  - Insert text at cursor
  - Replace document content
  - Search your vault by keyword
  - Open any note in a new tab
  - List outgoing links
- **Rich sidebar transcript** — see what was said, what tools ran, and what files were touched
- **Hotkey support** — bind a key to toggle the voice connection without touching the panel
- **Context banner** — always shows which file and how many chars the AI has as context

## Requirements

- An [OpenAI API key](https://platform.openai.com/api-keys) with Realtime API access
- Obsidian 1.0.0 or later (desktop only)

## Installation via BRAT

1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) from the Obsidian community plugins
2. Open BRAT settings → **Add Beta Plugin**
3. Enter: `rbcodelabs/obsidian-voice`
4. Enable the **Voice** plugin in Settings → Community plugins

## Setup

1. Open Settings → Voice
2. Paste your OpenAI API key
3. Choose a voice (Marin is the default)
4. Optionally add extra system prompt instructions
5. Click the mic icon in the ribbon (or use your hotkey) to open the Voice panel
6. Open a note, then click **Connect**

## Usage

Once connected, just speak. The AI has your document in context and can answer questions or edit it on request. Tool actions appear as pills in the transcript so you can follow along.

To assign a hotkey: Settings → Hotkeys → search "Toggle Voice connection".

## Model

Uses `gpt-realtime-2` via the OpenAI Realtime API (WebRTC).
