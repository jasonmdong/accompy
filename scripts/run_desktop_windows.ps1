$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Missing .venv. Run .\scripts\setup_desktop_windows.ps1 first."
}

$defaultAudiveris = "C:\Program Files\Audiveris\Audiveris.exe"
if (-not $env:AUDIVERIS_BIN -and (Test-Path $defaultAudiveris)) {
    $env:AUDIVERIS_BIN = $defaultAudiveris
}

npm run desktop
