# Local Cursor — Offline Coding Assistant (Ollama / LM Studio)

A ready-to-use, fully local coding assistant with a built-in editor, chat, file manager, and streaming responses.
Works with **Ollama** or **LM Studio** on your machine. No cloud, no paid APIs.

## Features
- Local-only: Uses your **Ollama** (`http://localhost:11434`) or **LM Studio** (`http://localhost:1234`) server
- Chat + streaming responses
- File explorer, open/save, create/rename/delete
- Editor with line numbers, soft-wrap, and basic shortcuts (Ctrl/Cmd+S to save)
- Search & replace across files or in an open file
- History log stored locally (`backend/data/history.json`)
- Model parameters: temperature, top_p, max_tokens
- Model switcher & backend switcher (Ollama or LM Studio)
- Dark/Light theme toggle
- Cross-platform: Windows, macOS, Linux

> Note: For strict offline usage, no external CDNs are used. The editor is a lightweight built-in component.

## Prereqs
- Python 3.10+ installed
- **EITHER** Ollama running (default http://localhost:11434)  
  or **LM Studio** local server running (default http://localhost:1234 with OpenAI-compatible API enabled)

## Quick Start (Windows PowerShell)
```powershell
./run.ps1
```
This will create a venv, install deps, and start the app at http://127.0.0.1:8000

## Quick Start (macOS/Linux Bash)
```bash
chmod +x run.sh
./run.sh
```
Then open http://127.0.0.1:8000

## Settings
Click the ⚙️ icon in the top bar to switch between Ollama and LM Studio, choose a model, and adjust parameters.
Settings are persisted in `backend/settings.json`.

## Notes
- For **Ollama** models list, we query `/api/tags` locally.
- For **LM Studio** models list, we query `/v1/models` locally.
- Streaming:
  - Ollama: `/api/generate` with `"stream": true`
  - LM Studio: `/v1/chat/completions` with `stream: true` (SSE-like chunks)

Enjoy!
