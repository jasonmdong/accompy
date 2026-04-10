#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d .venv ]]; then
  echo "Missing .venv. Run ./scripts/setup_desktop_mac.sh first."
  exit 1
fi

source .venv/bin/activate

if ! python -c "import PyInstaller" >/dev/null 2>&1; then
  echo "PyInstaller is not installed in .venv."
  echo "Run: pip install pyinstaller"
  exit 1
fi

rm -rf build/backend dist/backend

pyinstaller \
  --noconfirm \
  --clean \
  --name accompy-backend \
  --onefile \
  --paths "$ROOT_DIR" \
  --add-data "static:static" \
  --add-data "scores:scores" \
  src/desktop_backend.py

mkdir -p dist/backend
mv dist/accompy-backend dist/backend/accompy-backend

echo
echo "Bundled backend built at:"
echo "  $ROOT_DIR/dist/backend/accompy-backend"
