# v2 OCR worker contract

This image is the stdout-JSONL boundary for the v2 OCR pipeline. It accepts
bounded raw BGR frames on stdin and writes only detection JSONL to stdout.
Progress and completion messages are written to stderr.

The image installs the pinned GPU runtime from `requirements.txt` and uses
FFmpeg/ffprobe from Debian Bookworm. The build fails if the FFmpeg package does
not expose the `fps_mode` option required by the v2 media adapter. The audited
legacy OCR images remain unchanged and are not imported by this worker.

## Build

```bash
docker build -f containers/ocr-v2/Dockerfile -t ytb-vps-v2-ocr:cuda124 .
```

The runtime requires an NVIDIA Container Toolkit host. Run the provider smoke
before sending frames:

```bash
docker run --rm --gpus all ytb-vps-v2-ocr:cuda124 --provider-smoke
```

The smoke output must list `CUDAExecutionProvider` first for both detector and
recognizer. A worker run keeps the existing bounded raw-BGR/stdout-JSONL
contract:

```bash
cat frame.bgr | docker run --rm -i --gpus all ytb-vps-v2-ocr:cuda124 \
  --width 640 --height 360 --start-frame 0 --expected-frames 1 \
  --no-change-detection
```
