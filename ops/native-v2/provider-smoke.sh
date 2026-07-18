#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
V2_ROOT="${YTB_V2_ROOT:-/opt/ytb-vps-v2-native}"

command -v ffmpeg-v2 >/dev/null 2>&1
command -v ffprobe-v2 >/dev/null 2>&1
ffmpeg-v2 -h full 2>&1 | grep -- "-fps_mode" >/dev/null
ffprobe-v2 -version >/dev/null 2>&1
exec "$V2_ROOT/.venv/bin/python" "$REPO_ROOT/containers/ocr-v2/provider_smoke.py"
