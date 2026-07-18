# Native v2 GPU profile

Use this profile on the inexpensive Community GPU template where Docker
containers cannot be created. It uses the host's CUDA 12.4 libraries, a
private Python 3.10 virtualenv, pinned cuDNN, and a pinned FFmpeg 7.0.2 binary.

From the repository root on the VPS:

```bash
bash ops/native-v2/bootstrap.sh
bash ops/native-v2/provider-smoke.sh
```

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
