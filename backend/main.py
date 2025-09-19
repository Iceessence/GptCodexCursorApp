import asyncio
import json
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator, Dict, List, Optional

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response
from sse_starlette.sse import EventSourceResponse

BACKEND_ROOT = Path(__file__).resolve().parent
APP_ROOT = BACKEND_ROOT.parent
IS_FROZEN = getattr(sys, "frozen", False)
EXEC_ROOT = Path(sys.executable).resolve().parent if IS_FROZEN else APP_ROOT
RESOURCE_ROOT = Path(getattr(sys, "_MEIPASS", EXEC_ROOT if IS_FROZEN else APP_ROOT))
FRONTEND_ROOT = RESOURCE_ROOT / "frontend"
WORKSPACE_ROOT = EXEC_ROOT / "workspace"
SETTINGS_PATH = (EXEC_ROOT / "settings.json") if IS_FROZEN else BACKEND_ROOT / "settings.json"
HISTORY_DIR = (EXEC_ROOT / "data") if IS_FROZEN else BACKEND_ROOT / "data"
HISTORY_PATH = HISTORY_DIR / "history.json"

DEFAULT_SETTINGS: Dict[str, Any] = {
    "backend": "ollama",
    "ollama_base_url": "http://127.0.0.1:11434",
    "lmstudio_base_url": "http://127.0.0.1:1234",
    "model": "",
    "temperature": 0.2,
    "top_p": 0.9,
    "max_tokens": 2048,
}

WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
HISTORY_DIR.mkdir(parents=True, exist_ok=True)


def _ensure_settings() -> None:
    if not SETTINGS_PATH.exists():
        SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(SETTINGS_PATH, "w", encoding="utf-8") as fh:
            json.dump(DEFAULT_SETTINGS, fh, indent=2)

    if not HISTORY_PATH.exists():
        HISTORY_PATH.parent.mkdir(parents=True, exist_ok=True)
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


class NoCacheStaticFiles(StaticFiles):
    """StaticFiles variant that always revalidates assets."""

    async def get_response(self, path: str, scope):  # type: ignore[override]
        response: Response = await super().get_response(path, scope)
        # Disable aggressive browser caching so UI changes show up on refresh.
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response

    def is_not_modified(self, response_headers, request_headers) -> bool:  # type: ignore[override]
        return False


app = FastAPI(title="Local Cursor")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

app.mount(
    "/assets",
    NoCacheStaticFiles(directory=str(FRONTEND_ROOT / "assets")),
    name="assets",
)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(str(FRONTEND_ROOT / "index.html"))


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
        models = await query_available_models(backend_name, base_url, settings, timeout)
    except Exception as exc:  # pragma: no cover - defensive, network issues vary
        return {"backend": backend_name, "models": [], "error": str(exc)}

    return {"backend": backend_name, "models": models}


async def query_available_models(
    backend_name: str,
    base_url: Optional[str],
    settings: Dict[str, Any],
    timeout: httpx.Timeout,
) -> List[str]:
    url = base_url or (
        settings["ollama_base_url"] if backend_name == "ollama" else settings["lmstudio_base_url"]
    )
    async with httpx.AsyncClient(timeout=timeout) as client:
        if backend_name == "ollama":
            response = await client.get(f"{url.rstrip('/')}/api/tags")
            response.raise_for_status()
            data = response.json()
            return [item["name"] for item in data.get("models", []) if item.get("name")]
        response = await client.get(f"{url.rstrip('/')}/v1/models")
        response.raise_for_status()
        data = response.json()
        return [item["id"] for item in data.get("data", []) if item.get("id")]


@app.post("/backend/test")
async def test_backend(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    settings = load_settings()
    payload = payload or {}
    backend_name = payload.get("backend") or settings["backend"]
    base_url = payload.get("base_url")
    timeout = httpx.Timeout(5.0, read=20.0)
    started = datetime.utcnow()

    try:
        models = await query_available_models(backend_name, base_url, settings, timeout)
    except Exception as exc:  # pragma: no cover - depends on local setup
        return {
            "ok": False,
            "backend": backend_name,
            "error": str(exc),
            "base_url": base_url or (settings["ollama_base_url"] if backend_name == "ollama" else settings["lmstudio_base_url"]),
        }

    duration = (datetime.utcnow() - started).total_seconds()
    preview = models[:5]
    return {
        "ok": True,
        "backend": backend_name,
        "base_url": base_url or (settings["ollama_base_url"] if backend_name == "ollama" else settings["lmstudio_base_url"]),
        "latency_seconds": duration,
        "model_count": len(models),
        "models_preview": preview,
    }


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
    yield {"event": "status", "data": json.dumps({"stage": "connecting"})}
    async with client.stream("POST", f"{url.rstrip('/')}/api/generate", json=payload) as response:
        response.raise_for_status()
        yield {"event": "status", "data": json.dumps({"stage": "connected"})}
        first_token = True
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
                if first_token:
                    first_token = False
                    yield {"event": "status", "data": json.dumps({"stage": "streaming"})}
                yield {"event": "delta", "data": token}
            if data.get("done"):
                break
    yield {"event": "status", "data": json.dumps({"stage": "completed"})}


async def _stream_lmstudio(
    client: httpx.AsyncClient,
    url: str,
    payload: Dict[str, Any],
    request: Request,
) -> AsyncGenerator[Dict[str, str], None]:
    yield {"event": "status", "data": json.dumps({"stage": "connecting"})}
    async with client.stream("POST", f"{url.rstrip('/')}/v1/chat/completions", json=payload) as response:
        response.raise_for_status()
        yield {"event": "status", "data": json.dumps({"stage": "connected"})}
        first_token = True
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
                if first_token:
                    first_token = False
                    yield {"event": "status", "data": json.dumps({"stage": "streaming"})}
                yield {"event": "delta", "data": delta}
    yield {"event": "status", "data": json.dumps({"stage": "completed"})}


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
                    yield {"event": "status", "data": json.dumps({"stage": "error", "message": str(exc)})}
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
                    yield {"event": "status", "data": json.dumps({"stage": "error", "message": str(exc)})}
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

def _safe_join(base: Path, path: str) -> Path:
    target = (base / (path or "")).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid path") from exc
    return target


@app.get("/fs/list")
async def fs_list(path: str = "") -> Dict[str, Any]:
    target = _safe_join(WORKSPACE_ROOT, path)
    if not target.exists():
        return {"path": path, "items": []}
    items: List[Dict[str, Any]] = []
    for name in sorted(p.name for p in target.iterdir()):
        full_path = target / name
        items.append(
            {
                "name": name,
                "path": full_path.relative_to(WORKSPACE_ROOT).as_posix(),
                "is_dir": full_path.is_dir(),
                "size": full_path.stat().st_size if full_path.is_file() else 0,
            }
        )
    return {"path": path, "items": items}


@app.get("/fs/read")
async def fs_read(path: str) -> Dict[str, Any]:
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(404, "File not found")
    with target.open("r", encoding="utf-8", errors="ignore") as fh:
        content = fh.read()
    return {"path": path, "content": content}


@app.post("/fs/write")
async def fs_write(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload.get("path")
    content = payload.get("content", "")
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as fh:
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
        target.mkdir(parents=True, exist_ok=True)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8") as fh:
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
    dest.parent.mkdir(parents=True, exist_ok=True)
    source.replace(dest)
    return {"ok": True}


@app.post("/fs/delete")
async def fs_delete(payload: Dict[str, Any]) -> Dict[str, Any]:
    path = payload.get("path")
    if not path:
        raise HTTPException(400, "Path is required")
    target = _safe_join(WORKSPACE_ROOT, path)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    return {"ok": True}


@app.post("/fs/search")
async def fs_search(payload: Dict[str, Any]) -> Dict[str, Any]:
    query = (payload.get("query") or "").lower()
    scope = payload.get("path", "")
    if not query:
        return {"matches": []}

    base_dir = _safe_join(WORKSPACE_ROOT, scope)
    if not base_dir.exists():
        return {"matches": []}

    matches: List[Dict[str, Any]] = []
    for root_dir, _, files in os.walk(base_dir):
        for filename in files:
            file_path = Path(root_dir) / filename
            relative = file_path.relative_to(WORKSPACE_ROOT).as_posix()
            if query in filename.lower():
                matches.append({"path": relative, "line": 0, "context": filename})
            try:
                with file_path.open("r", encoding="utf-8", errors="ignore") as fh:
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
