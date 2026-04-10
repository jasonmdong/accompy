#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ ! -d .venv ]]; then
  echo "Missing .venv. Run ./scripts/setup_desktop_mac.sh first."
  exit 1
fi

source .venv/bin/activate

if [[ -z "${AUDIVERIS_BIN:-}" ]] && [[ -x "/Applications/Audiveris.app/Contents/MacOS/Audiveris" ]]; then
  export AUDIVERIS_BIN="/Applications/Audiveris.app/Contents/MacOS/Audiveris"
fi

npm run desktop
