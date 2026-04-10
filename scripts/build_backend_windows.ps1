$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$venvPython = Join-Path $root ".venv\Scripts\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Missing .venv. Run .\scripts\setup_desktop_windows.ps1 first."
}

try {
    & $venvPython -c "import PyInstaller" | Out-Null
} catch {
    throw "PyInstaller is not installed in .venv. Run: .venv\Scripts\python.exe -m pip install pyinstaller"
}

if (Test-Path "build\backend") { Remove-Item -Recurse -Force "build\backend" }
if (Test-Path "dist\backend") { Remove-Item -Recurse -Force "dist\backend" }
if (Test-Path "dist\accompy-backend.exe") { Remove-Item -Force "dist\accompy-backend.exe" }

& $venvPython -m PyInstaller `
  --noconfirm `
  --clean `
  --name accompy-backend `
  --onefile `
  --paths $root `
  --add-data "static;static" `
  --add-data "scores;scores" `
  src/desktop_backend.py

New-Item -ItemType Directory -Force -Path "dist\backend" | Out-Null
Move-Item "dist\accompy-backend.exe" "dist\backend\accompy-backend.exe"

Write-Host ""
Write-Host "Bundled backend built at:"
Write-Host "  $root\dist\backend\accompy-backend.exe"
