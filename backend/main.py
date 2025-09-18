import os
import json
import asyncio
from datetime import datetime
from typing import List, Optional, Dict, Any

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(APP_DIR, "frontend")
DATA_DIR = os.path.join(BACKEND_DIR, "data")
SETTINGS_PATH = os.path.join(BACKEND_DIR, "settings.json")
HISTORY_PATH = os.path.join(DATA_DIR, "history.json")

DEFAULT_SETTINGS = {
    "backend": "ollama",
    "ollama_base_url": "http://127.0.0.1:11434",
    "lmstudio_base_url": "http://127.0.0.1:1234",
    "model": "qwen2.5-coder:7b",
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 2048
}

os.makedirs(DATA_DIR, exist_ok=True)
if not os.path.exists(SETTINGS_PATH):
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(DEFAULT_SETTINGS, f, indent=2)
if not os.path.exists(HISTORY_PATH):
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump({"sessions": []}, f, indent=2)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static frontend
app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_DIR, "assets")), name="assets")

@app.get("/")
async def root():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

def load_settings() -> Dict[str, Any]:
    with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)

def save_settings(s: Dict[str, Any]) -> None:
    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)

def append_history(entry: Dict[str, Any]) -> None:
    with open(HISTORY_PATH, "r", encoding="utf-8") as f:
        hist = json.load(f)
    hist.setdefault("sessions", []).append(entry)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(hist, f, indent=2)

@app.get("/api/health")
async def health():
    s = load_settings()
    return {"status": "ok", "settings": s}

@app.get("/api/settings")
async def get_settings():
    return load_settings()

@app.post("/api/settings")
async def update_settings(payload: Dict[str, Any]):
    s = load_settings()
    s.update({
        "backend": payload.get("backend", s["backend"]),
        "ollama_base_url": payload.get("ollama_base_url", s["ollama_base_url"]),
        "lmstudio_base_url": payload.get("lmstudio_base_url", s["lmstudio_base_url"]),
        "model": payload.get("model", s["model"]),
        "temperature": payload.get("temperature", s["temperature"]),
        "top_p": payload.get("top_p", s["top_p"]),
        "max_tokens": payload.get("max_tokens", s["max_tokens"]),
    })
    save_settings(s)
    return {"ok": True, "settings": s}

@app.get("/api/models")
async def list_models():
    s = load_settings()
    backend = s["backend"]
    timeout = httpx.Timeout(5.0, read=15.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        try:
            if backend == "ollama":
                r = await client.get(f'{s["ollama_base_url"].rstrip("/")}/api/tags')
                r.raise_for_status()
                data = r.json()
                models = [m.get("name") for m in data.get("models", []) if m.get("name")]
                return {"backend": "ollama", "models": models}
            else:
                # LM Studio OpenAI-compatible
                r = await client.get(f'{s["lmstudio_base_url"].rstrip("/")}/v1/models')
                r.raise_for_status()
                data = r.json()
                models = [m.get("id") for m in data.get("data", []) if m.get("id")]
                return {"backend": "lmstudio", "models": models}
        except Exception as e:
            return {"backend": backend, "models": [], "error": str(e)}

@app.post("/api/chat/stream")
async def chat_stream(request: Request):
    payload = await request.json()
    user_messages = payload.get("messages", [])
    s = load_settings()

    async def event_generator():
        # stream from local backend
        backend = s["backend"]
        model = payload.get("model") or s["model"]
        temperature = payload.get("temperature", s["temperature"])
        top_p = payload.get("top_p", s["top_p"])
        max_tokens = payload.get("max_tokens", s["max_tokens"])

        timeout = httpx.Timeout(5.0, read=300.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            if backend == "ollama":
                # Convert chat format to a single prompt for simplicity
                # (You can improve here to use /api/chat for multi-turn with roles)
                prompt_parts = []
                for m in user_messages:
                    role = m.get("role", "user")
                    content = m.get("content", "")
                    prompt_parts.append(f"{role.upper()}: {content}")
                prompt = "\n".join(prompt_parts) + "\nASSISTANT:"

                req = {
                    "model": model,
                    "prompt": prompt,
                    "stream": True,
                    "options": {
                        "temperature": temperature,
                        "top_p": top_p,
                        "num_ctx": max_tokens
                    }
                }
                try:
                    async with client.stream("POST", f'{s["ollama_base_url"].rstrip("/")}/api/generate', json=req) as r:
                        async for line in r.aiter_lines():
                            if await request.is_disconnected():
                                break
                            if not line:
                                continue
                            try:
                                data = json.loads(line)
                            except Exception:
                                continue
                            token = data.get("response", "")
                            if token:
                                yield {"event": "delta", "data": token}
                            if data.get("done"):
                                break
                except Exception as e:
                    yield {"event": "error", "data": str(e)}
            else:
                # LM Studio (OpenAI-compatible) streaming chat completions
                messages = [{"role": m.get("role", "user"), "content": m.get("content","")} for m in user_messages]
                req = {
                    "model": model,
                    "messages": messages,
                    "stream": True,
                    "temperature": temperature,
                    "top_p": top_p,
                    "max_tokens": max_tokens
                }
                try:
                    async with client.stream("POST", f'{s["lmstudio_base_url"].rstrip("/")}/v1/chat/completions', json=req) as r:
                        async for line in r.aiter_lines():
                            if await request.is_disconnected():
                                break
                            if not line.startswith("data:"):
                                continue
                            chunk = line[len("data:"):].strip()
                            if chunk == "[DONE]":
                                break
                            try:
                                data = json.loads(chunk)
                                delta = data.get("choices",[{}])[0].get("delta",{}).get("content","")
                                if delta:
                                    yield {"event": "delta", "data": delta}
                            except Exception:
                                continue
                except Exception as e:
                    yield {"event": "error", "data": str(e)}

        # Record history minimal
        try:
            append_history({
                "ts": datetime.utcnow().isoformat()+"Z",
                "messages": user_messages,
                "model": model,
                "backend": backend
            })
        except Exception:
            pass

    return EventSourceResponse(event_generator())

# -------- File System APIs --------

def safe_join(base: str, path: str) -> str:
    full = os.path.abspath(os.path.join(base, path))
    if not full.startswith(os.path.abspath(base)):
        raise HTTPException(400, "Invalid path traversal")
    return full

WORKSPACE_ROOT = os.path.abspath(os.path.join(APP_DIR, "workspace"))
os.makedirs(WORKSPACE_ROOT, exist_ok=True)

@app.get("/api/fs/list")
async def fs_list(path: str = ""):
    target = safe_join(WORKSPACE_ROOT, path)
    if not os.path.exists(target):
        return {"path": path, "items": []}
    items = []
    for name in sorted(os.listdir(target)):
        p = os.path.join(target, name)
        items.append({
            "name": name,
            "path": os.path.relpath(p, WORKSPACE_ROOT).replace("\\","/"),
            "is_dir": os.path.isdir(p),
            "size": os.path.getsize(p) if os.path.isfile(p) else 0
        })
    return {"path": path, "items": items}

@app.get("/api/fs/read")
async def fs_read(path: str):
    target = safe_join(WORKSPACE_ROOT, path)
    if not os.path.exists(target) or not os.path.isfile(target):
        raise HTTPException(404, "File not found")
    with open(target, "r", encoding="utf-8", errors="ignore") as f:
        return {"path": path, "content": f.read()}

@app.post("/api/fs/write")
async def fs_write(payload: Dict[str, Any]):
    path = payload.get("path")
    content = payload.get("content","")
    if not path:
        raise HTTPException(400, "Missing path")
    target = safe_join(WORKSPACE_ROOT, path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        f.write(content)
    return {"ok": True}

@app.post("/api/fs/new")
async def fs_new(payload: Dict[str, Any]):
    path = payload.get("path")
    is_dir = bool(payload.get("is_dir", False))
    if not path:
        raise HTTPException(400, "Missing path")
    target = safe_join(WORKSPACE_ROOT, path)
    if is_dir:
        os.makedirs(target, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as f:
            f.write("")
    return {"ok": True}

@app.post("/api/fs/rename")
async def fs_rename(payload: Dict[str, Any]):
    src = payload.get("src")
    dst = payload.get("dst")
    if not src or not dst:
        raise HTTPException(400, "Missing src/dst")
    s = safe_join(WORKSPACE_ROOT, src)
    d = safe_join(WORKSPACE_ROOT, dst)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    os.replace(s, d)
    return {"ok": True}

@app.post("/api/fs/delete")
async def fs_delete(payload: Dict[str, Any]):
    path = payload.get("path")
    if not path:
        raise HTTPException(400, "Missing path")
    target = safe_join(WORKSPACE_ROOT, path)
    if os.path.isdir(target):
        # remove dir recursively
        for root, dirs, files in os.walk(target, topdown=False):
            for name in files:
                os.remove(os.path.join(root, name))
            for name in dirs:
                os.rmdir(os.path.join(root, name))
        os.rmdir(target)
    elif os.path.isfile(target):
        os.remove(target)
    return {"ok": True}

@app.post("/api/fs/search")
async def fs_search(payload: Dict[str, Any]):
    query = payload.get("query","").lower()
    scope = payload.get("path","")
    in_files_only = bool(payload.get("in_files_only", False))
    res = []
    base = safe_join(WORKSPACE_ROOT, scope)
    if not os.path.exists(base):
        return {"matches": []}
    for root_dir, dirs, files in os.walk(base):
        for fn in files:
            fpath = os.path.join(root_dir, fn)
            rel = os.path.relpath(fpath, WORKSPACE_ROOT).replace("\\","/")
            if not in_files_only and query in fn.lower():
                res.append({"path": rel, "line": 0, "context": fn})
            try:
                with open(fpath, "r", encoding="utf-8", errors="ignore") as fh:
                    for i, line in enumerate(fh, 1):
                        if query in line.lower():
                            res.append({"path": rel, "line": i, "context": line.strip()})
            except Exception:
                continue
    return {"matches": res}
