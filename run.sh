#!/usr/bin/env bash
set -e

HOST_URL="${HOST_URL:-127.0.0.1}"
PORT="${PORT:-8000}"

echo "==> Creating venv..."
python3 -m venv .venv
source .venv/bin/activate

echo "==> Upgrading pip..."
python -m pip install --upgrade pip

echo "==> Installing backend requirements..."
pip install -r backend/requirements.txt

echo "==> Starting server..."
UVICORN_HOST="$HOST_URL" UVICORN_PORT="$PORT" python -m uvicorn backend.main:app --host "$HOST_URL" --port "$PORT" --reload
