"""Convenience entry point for running the Local Cursor backend.

This module is used both for development and for the packaged executable.
"""
from __future__ import annotations

import argparse
import os
import threading
import time
import webbrowser
from typing import Optional

import uvicorn

DEFAULT_HOST = os.environ.get("UVICORN_HOST", "127.0.0.1")
DEFAULT_PORT = int(os.environ.get("UVICORN_PORT", "8000"))


def _open_browser(url: str, delay: float) -> None:
    def _target() -> None:
        time.sleep(delay)
        try:
            webbrowser.open(url)
        except Exception:
            # Opening a browser should never prevent the server from running.
            pass

    thread = threading.Thread(target=_target, daemon=True)
    thread.start()


def parse_args(args: Optional[list[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Launch the Local Cursor backend server")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Host/IP to bind (default: %(default)s)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to bind (default: %(default)s)")
    parser.add_argument(
        "--log-level",
        default=os.environ.get("UVICORN_LOG_LEVEL", "info"),
        help="Uvicorn log level (default: %(default)s)",
    )
    parser.add_argument(
        "--reload",
        action="store_true",
        help="Enable autoreload (useful during development only).",
    )
    parser.add_argument(
        "--open",
        dest="open_browser",
        action="store_true",
        help="Open the app in the default browser after the server starts.",
    )
    parser.add_argument(
        "--no-browser",
        dest="open_browser",
        action="store_false",
        help="Do not automatically open the browser (default when --reload is used).",
    )
    parser.set_defaults(open_browser=True)
    return parser.parse_args(args=args)


def main(args: Optional[list[str]] = None) -> None:
    parsed = parse_args(args)
    url = f"http://{parsed.host}:{parsed.port}"

    if parsed.open_browser and not parsed.reload:
        _open_browser(url, delay=1.0)

    uvicorn.run(
        "backend.main:app",
        host=parsed.host,
        port=parsed.port,
        reload=parsed.reload,
        log_level=parsed.log_level,
    )


if __name__ == "__main__":
    main()
