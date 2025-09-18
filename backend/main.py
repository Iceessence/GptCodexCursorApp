import asyncio
import json
import os
from datetime import datetime
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sse_starlette.sse import EventSourceResponse

APP_ROOT = os.path.dirname(os.path.abspath(os.path.join(__file__, os.pardir)))
BACKEND_ROOT = os.path.dirname(os.path.abspath(__file__))
FRONTEND_ROOT = os.path.join(APP_ROOT, "frontend")
WORKSPACE_ROOT = os.path.join(APP_ROOT, "workspace")
SETTINGS_PATH = os.path.join(BACKEND_ROOT, "settings.json")
HISTORY_DIR = os.path.join(BACKEND_ROOT, "data")
HISTORY_PATH = os.path.join(HISTORY_DIR, "history.json")

DEFAULT_SETTINGS: Dict[str, Any] = {
    "backend": "ollama",
    "ollama_base_url": "http://127.0.0.1:11434",
    "lmstudio_base_url": "http://127.0.0.1:1234",
    "model": "",
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 2048,
}

os.makedirs(WORKSPACE_ROOT, exist_ok=True)
os.makedirs(HISTORY_DIR, exist_ok=True)


def _ensure_settings() -> None:
    if not os.path.exists(SETTINGS_PATH):
        with open(SETTINGS_PATH, "w", encoding="utf-8") as fh:
            json.dump(DEFAULT_SETTINGS, fh, indent=2)

    if not os.path.exists(HISTORY_PATH):
        with open(HISTORY_PATH, "w", encoding="utf-8") as fh:
            json.dump({"sessions": []}, fh, indent=2)


_ensure_settings()


def load_settings() -> Dict[str, Any]:
    with open(SETTINGS_PATH, "r", encoding="utf-8") as fh:
        settings = json.load(fh)
    merged = DEFAULT_SETTINGS.copy()
    merged.update(settings)
    return merged


def save_settings(settings: Dict[str, Any]) -> None:
    merged = DEFAULT_SETTINGS.copy()
    merged.update(settings)
    with open(SETTINGS_PATH, "w", encoding="utf-8") as fh:
        json.dump(merged, fh, indent=2)


def append_history(entry: Dict[str, Any]) -> None:
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as fh:
            history = json.load(fh)
        history.setdefault("sessions", []).append(entry)
        with open(HISTORY_PATH, "w", encoding="utf-8") as fh:
            json.dump(history, fh, indent=2)
    except Exception:
        # history failures should never break chat
        pass


app = FastAPI(title="Local Cursor")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.mount("/assets", StaticFiles(directory=os.path.join(FRONTEND_ROOT, "assets")), name="assets")


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(os.path.join(FRONTEND_ROOT, "index.html"))


@app.get("/health")
async def health() -> Dict[str, Any]:
    settings = load_settings()
    return {"status": "ok", "settings": settings}


@app.get("/settings")
async def get_settings() -> Dict[str, Any]:
    return load_settings()


@app.post("/settings")
async def update_settings(payload: Dict[str, Any]) -> Dict[str, Any]:
    settings = load_settings()
    settings.update({
        "backend": payload.get("backend", settings["backend"]),
        "ollama_base_url": payload.get("ollama_base_url", settings["ollama_base_url"]),
        "lmstudio_base_url": payload.get("lmstudio_base_url", settings["lmstudio_base_url"]),
        "model": payload.get("model", settings["model"]),
        "temperature": payload.get("temperature", settings["temperature"]),
        "top_p": payload.get("top_p", settings["top_p"]),
        "max_tokens": payload.get("max_tokens", settings["max_tokens"]),
    })
    save_settings(settings)
    return {"ok": True, "settings": settings}


@app.get("/models")
async def list_models(backend: Optional[str] = None, base_url: Optional[str] = None) -> Dict[str, Any]:
    settings = load_settings()
    backend_name = backend or settings["backend"]
    timeout = httpx.Timeout(5.0, read=20.0)

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if backend_name == "ollama":
                url = base_url or settings["ollama_base_url"]
                response = await client.get(f"{url.rstrip('/')}/api/tags")
                response.raise_for_status()
                data = response.json()
                models = [item["name"] for item in data.get("models", []) if item.get("name")]
            else:
                url = base_url or settings["lmstudio_base_url"]
                response = await client.get(f"{url.rstrip('/')}/v1/models")
                response.raise_for_status()
                data = response.json()
                models = [item["id"] for item in data.get("data", []) if item.get("id")]
    except Exception as exc:
        return {"backend": backend_name, "models": [], "error": str(exc)}

    return {"backend": backend_name, "models": models}


def _flatten_messages(messages: List[Dict[str, Any]]) -> str:
    parts: List[str] = []
    for message in messages:
        role = message.get("role", "user").upper()
        content = message.get("content", "")
        parts.append(f"{role}: {content}")
    parts.append("ASSISTANT:")
    return "\n".join(parts)


async def _stream_ollama(
    client: httpx.AsyncClient,
    url: str,
    payload: Dict[str, Any],
    request: Request,
) -> AsyncGenerator[Dict[str, str], None]:
    async with client.stream("POST", f"{url.rstrip('/')}/api/generate", json=payload) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if await request.is_disconnected():
                break
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            token = data.get("response")
            if token:
                yield {"event": "delta", "data": token}
            if data.get("done"):
                break


async def _stream_lmstudio(
    client: httpx.AsyncClient,
    url: str,
    payload: Dict[str, Any],
    request: Request,
) -> AsyncGenerator[Dict[str, str], None]:
    async with client.stream("POST", f"{url.rstrip('/')}/v1/chat/completions", json=payload) as response:
        response.raise_for_status()
        async for raw_line in response.aiter_lines():
            if await request.is_disconnected():
                break
            if not raw_line:
                continue
            if not raw_line.startswith("data:"):
                continue
            chunk = raw_line[len("data:") :].strip()
            if chunk == "[DONE]":
                break
            try:
                data = json.loads(chunk)
            except json.JSONDecodeError:
                continue
            delta = data.get("choices", [{}])[0].get("delta", {}).get("content")
            if delta:
                yield {"event": "delta", "data": delta}


@app.post("/chat_stream")
async def chat_stream(request: Request) -> EventSourceResponse:
    payload = await request.json()
    settings = load_settings()
    backend_name = payload.get("backend") or settings["backend"]
    model = payload.get("model") or settings["model"]
    temperature = payload.get("temperature", settings["temperature"])
    top_p = payload.get("top_p", settings["top_p"])
    max_tokens = payload.get("max_tokens", settings["max_tokens"])
    messages = payload.get("messages", [])

    if not model:
        raise HTTPException(400, "Model is required")

    async def event_generator() -> AsyncGenerator[Dict[str, str], None]:
        timeout = httpx.Timeout(5.0, read=300.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            if backend_name == "ollama":
                base_url = payload.get("ollama_base_url") or settings["ollama_base_url"]
                req = {
                    "model": model,
                    "prompt": _flatten_messages(messages),
                    "stream": True,
                    "options": {
                        "temperature": temperature,
                        "top_p": top_p,
                        "num_ctx": max_tokens,
                    },
                }
                try:
                    async for event in _stream_ollama(client, base_url, req, request):
                        yield event
                except Exception as exc:
                    yield {"event": "error", "data": str(exc)}
            else:
                base_url = payload.get("lmstudio_base_url") or settings["lmstudio_base_url"]
                req = {
                    "model": model,
                    "messages": messages,
                    "stream": True,
                    "temperature": temperature,
                    "top_p": top_p,
                    "max_tokens": max_tokens,
                }
                try:
                    async for event in _stream_lmstudio(client, base_url, req, request):
                        yield event
                except Exception as exc:
                    yield {"event": "error", "data": str(exc)}
        yield {"event": "end", "data": ""}

    asyncio.create_task(
        asyncio.to_thread(
            append_history,
            {
                "timestamp": datetime.utcnow().isoformat() + "Z",
                "backend": backend_name,
                "model": model,
                "messages": messages,
            },
        )
    )

    return EventSourceResponse(event_generator())


@app.post("/chat_once")
async def chat_once(payload: Dict[str, Any]) -> Dict[str, Any]:
    settings = load_settings()
    backend_name = payload.get("backend") or settings["backend"]
    model = payload.get("model") or settings["model"]
    temperature = payload.get("temperature", settings["temperature"])
    top_p = payload.get("top_p", settings["top_p"])
    max_tokens = payload.get("max_tokens", settings["max_tokens"])
    messages = payload.get("messages", [])

    if not model:
        raise HTTPException(400, "Model is required")

    timeout = httpx.Timeout(10.0, read=300.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        if backend_name == "ollama":
            base_url = payload.get("ollama_base_url") or settings["ollama_base_url"]
            req = {
                "model": model,
                "prompt": _flatten_messages(messages),
                "stream": False,
                "options": {
                    "temperature": temperature,
                    "top_p": top_p,
                    "num_ctx": max_tokens,
                },
            }
            response = await client.post(f"{base_url.rstrip('/')}/api/generate", json=req)
            response.raise_for_status()
            data = response.json()
            text = data.get("response", "")
        else:
            base_url = payload.get("lmstudio_base_url") or settings["lmstudio_base_url"]
            req = {
                "model": model,
                "messages": messages,
                "stream": False,
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
            }
            response = await client.post(f"{base_url.rstrip('/')}/v1/chat/completions", json=req)
            response.raise_for_status()
            data = response.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")

    append_history(
        {
            "timestamp": datetime.utcnow().isoformat() + "Z",
            "backend": backend_name,
            "model": model,
            "messages": messages,
            "response": text,
        }
    )

    return {"backend": backend_name, "model": model, "response": text}


# -----------------------
# Workspace file endpoints
# -----------------------

def _safe_join(base: str, path: str) -> str:
    target = os.path.abspath(os.path.join(base, path))
    base_abs = os.path.abspath(base)
    if not target.startswith(base_abs):
        raise HTTPException(status_code=400, detail="Invalid path")
    return target


@app.get("/fs/list")
async def fs_list(path: str = "") -> Dict[str, Any]:
    target = _safe_join(WORKSPACE_ROOT, path)
    if not os.path.exists(target):
        return {"path": path, "items": []}
    items: List[Dict[str, Any]] = []
    for name in sorted(os.listdir(target)):
        full_path = os.path.join(target, name)
        items.append(
            {
                "name": name,
                "path": os.path.relpath(full_path, WORKSPACE_ROOT).replace("\\", "/"),
                "is_dir": os.path.isdir(full_path),
                "size": os.path.getsize(full_path) if os.path.isfile(full_path) else 0,
            }
        )
    return {"path": path, "items": items}


@app.get("/fs/read")
async def fs_read(path: str) -> Dict[str, Any]:
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    if not os.path.exists(target) or not os.path.isfile(target):
        raise HTTPException(404, "File not found")
    with open(target, "r", encoding="utf-8", errors="ignore") as fh:
        content = fh.read()
    return {"path": path, "content": content}


@app.post("/fs/write")
async def fs_write(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload.get("path")
    content = payload.get("content", "")
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        fh.write(content)
    return {"ok": True}


@app.post("/fs/new")
async def fs_new(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload.get("path")
    is_dir = bool(payload.get("is_dir", False))
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    if is_dir:
        os.makedirs(target, exist_ok=True)
    else:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        with open(target, "w", encoding="utf-8") as fh:
            fh.write("")
    return {"ok": True}


@app.post("/fs/rename")
async def fs_rename(payload: Dict[str, Any]) -> Dict[str, Any]:
    src = payload.get("src")
    dst = payload.get("dst")
    if not src or not dst:
        raise HTTPException(400, "src and dst are required")
    source = _safe_join(WORKSPACE_ROOT, src)
    dest = _safe_join(WORKSPACE_ROOT, dst)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    os.replace(source, dest)
    return {"ok": True}


@app.post("/fs/delete")
async def fs_delete(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload.get("path")
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    if os.path.isdir(target):
        for root, dirs, files in os.walk(target, topdown=False):
            for filename in files:
                os.remove(os.path.join(root, filename))
            for dirname in dirs:
                os.rmdir(os.path.join(root, dirname))
        os.rmdir(target)
    elif os.path.exists(target):
        os.remove(target)
    return {"ok": True}


@app.post("/fs/search")
async def fs_search(payload: Dict[str, Any]) -> Dict[str, Any]:
    query = (payload.get("query") or "").lower()
    scope = payload.get("path", "")
    if not query:
        return {"matches": []}

    base_dir = _safe_join(WORKSPACE_ROOT, scope)
    if not os.path.exists(base_dir):
        return {"matches": []}

    matches: List[Dict[str, Any]] = []
    for root_dir, _, files in os.walk(base_dir):
        for filename in files:
            file_path = os.path.join(root_dir, filename)
            relative = os.path.relpath(file_path, WORKSPACE_ROOT).replace("\\", "/")
            if query in filename.lower():
                matches.append({"path": relative, "line": 0, "context": filename})
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as fh:
                    for line_number, line in enumerate(fh, start=1):
                        if query in line.lower():
                            matches.append(
                                {
                                    "path": relative,
                                    "line": line_number,
                                    "context": line.strip(),
                                }
                            )
            except Exception:
                continue
    return {"matches": matches}
