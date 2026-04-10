$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Resolve-Python {
    if (Get-Command py -ErrorAction SilentlyContinue) { return "py -3" }
    if (Get-Command python -ErrorAction SilentlyContinue) { return "python" }
    throw "Python 3 is required but was not found."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm is required but was not found."
}

$python = Resolve-Python

if (-not (Test-Path ".venv")) {
    Write-Host "Creating Python virtual environment..."
    Invoke-Expression "$python -m venv .venv"
}

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Expected virtual environment python at $venvPython"
}

Write-Host "Installing Python dependencies..."
& $venvPython -m pip install -r requirements.txt

Write-Host "Installing desktop dependencies..."
npm install

Write-Host ""
Write-Host "Desktop beta setup complete."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Install Audiveris separately if you want PDF/image import."
Write-Host "  2. Launch the desktop app with:"
Write-Host "       powershell -ExecutionPolicy Bypass -File .\scripts\run_desktop_windows.ps1"
Write-Host ""
Write-Host "User score files will live in:"
Write-Host "  %APPDATA%\accompy\scores"
