# Native v2 GPU profile

Use this profile on the inexpensive Community GPU template where Docker
containers cannot be created. It uses the host's CUDA 12.4 libraries, a
private Python 3.10 virtualenv, pinned cuDNN, and a pinned FFmpeg 7.0.2 binary.

From the repository root on the VPS:

```bash
bash ops/native-v2/bootstrap.sh
bash ops/native-v2/provider-smoke.sh
```

For a real media smoke test after the VPS is attached, run the native pipeline
against a local source file. The command writes a verified rendered MP4 and a
canonical WAV TTS artifact under the workspace; `--blur` accepts source-pixel
rectangles in `xmin:ymin:xmax:ymax` form:

```bash
python -m ytb_vps_v2 media-run \
  --source /var/lib/ytb-vps/input/source.mp4 \
  --workspace /var/lib/ytb-vps/runs/test-1 \
  --blur 20:20:320:160 \
  --tts-provider capcut
```

The smoke test uses the same fixed CapCut BV074 voice as the worker. Configure
`YTB_VPS_CAPCUT_DEVICE_FILE` or `YTB_VPS_CAPCUT_DEVICE_POOL_DIR` before running
it; there is no Edge TTS fallback.

The next control-plane bridge will supply the source and saved scene settings
to this same command; it is deliberately not a second renderer.

The smoke check must report `CUDAExecutionProvider` first for both RapidOCR
detector and recognizer sessions. To run the bounded worker directly:

```bash
cat frame.bgr | bash ops/native-v2/worker.sh \
  --width 640 --height 360 --start-frame 0 --expected-frames 1 \
  --no-change-detection --output -
```

Configure the media adapter with `ffmpeg-v2` and `ffprobe-v2`; Ubuntu 22.04's
system FFmpeg 4.4 does not support the v2 `fps_mode` contract. The native
profile is intentionally less isolated than Docker, but it is the supported
deployment mode for a Community GPU host.
