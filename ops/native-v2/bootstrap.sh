#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run this bootstrap as root." >&2
    exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)"
V2_ROOT="${YTB_V2_ROOT:-/opt/ytb-vps-v2-native}"
FFMPEG_ROOT="${YTB_FFMPEG_ROOT:-/opt/ffmpeg-static}"
FFMPEG_ARCHIVE="/tmp/ffmpeg-7.0.2-amd64-static.tar.xz"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-7.0.2-amd64-static.tar.xz"
FFMPEG_SHA256="abda8d77ce8309141f83ab8edf0596834087c52467f6badf376a6a2a4c87cf67"

if ! command -v nvidia-smi >/dev/null 2>&1; then
    echo "nvidia-smi is required; select a CUDA 12.4 GPU template." >&2
    exit 1
fi
if [[ ! -d /usr/local/cuda-12.4 ]]; then
    echo "/usr/local/cuda-12.4 is required from the host template." >&2
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
    ca-certificates curl libgl1 libglib2.0-0 python3.10 python3.10-venv xz-utils

install -d -m 0755 "$V2_ROOT" "$FFMPEG_ROOT"
python3.10 -m venv "$V2_ROOT/.venv"
"$V2_ROOT/.venv/bin/python" -m pip install --upgrade pip==25.3
"$V2_ROOT/.venv/bin/python" -m pip install --no-cache-dir \
    -r "$REPO_ROOT/containers/ocr-v2/requirements-native.txt"
"$V2_ROOT/.venv/bin/python" -m pip install --no-cache-dir --no-deps nvidia-cudnn-cu12==9.24.0.43
"$V2_ROOT/.venv/bin/python" -m pip install --no-cache-dir --no-deps -e "$REPO_ROOT"

if ! echo "$FFMPEG_SHA256  $FFMPEG_ARCHIVE" | sha256sum -c - >/dev/null 2>&1; then
    curl -fL --retry 3 -o "$FFMPEG_ARCHIVE" "$FFMPEG_URL"
fi
echo "$FFMPEG_SHA256  $FFMPEG_ARCHIVE" | sha256sum -c -
install -d -m 0755 "$FFMPEG_ROOT"
tar -xJf "$FFMPEG_ARCHIVE" -C "$FFMPEG_ROOT" --strip-components=1
ln -sfn "$FFMPEG_ROOT/ffmpeg" /usr/local/bin/ffmpeg-v2
ln -sfn "$FFMPEG_ROOT/ffprobe" /usr/local/bin/ffprobe-v2

printf '%s\n' "$V2_ROOT/.venv/lib/python3.10/site-packages/nvidia/cudnn/lib" \
    > /etc/ld.so.conf.d/ytb-vps-v2-cudnn.conf
ldconfig

bash "$SCRIPT_DIR/provider-smoke.sh"
echo "Native v2 runtime installed under $V2_ROOT"
