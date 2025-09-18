param(
    [string]$HostUrl = "127.0.0.1",
    [int]$Port = 8000
)

$ErrorActionPreference = "Stop"

Write-Host "==> Creating venv..." -ForegroundColor Cyan
python -m venv .venv
if (!(Test-Path ".\.venv\Scripts\Activate.ps1")) {
    Write-Error "Virtual environment not created. Ensure Python 3.10+ is installed and on PATH."
}
& .\.venv\Scripts\Activate.ps1

Write-Host "==> Upgrading pip..." -ForegroundColor Cyan
python -m pip install --upgrade pip

Write-Host "==> Installing backend requirements..." -ForegroundColor Cyan
pip install -r backend\requirements.txt

Write-Host "==> Starting server..." -ForegroundColor Cyan
$env:UVICORN_HOST = $HostUrl
$env:UVICORN_PORT = $Port
python -m uvicorn backend.main:app --host $HostUrl --port $Port --reload
