#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required but was not found."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required but was not found."
  exit 1
fi

if [[ ! -d .venv ]]; then
  echo "Creating Python virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

echo "Installing Python dependencies..."
pip install -r requirements.txt

echo "Installing desktop dependencies..."
npm install

cat <<EOF

Desktop beta setup complete.

Next steps:
  1. Install Audiveris separately if you want PDF/image import.
  2. Launch the desktop app with:
       ./scripts/run_desktop_mac.sh

User score files will live in:
  ~/Library/Application Support/accompy/scores

EOF
