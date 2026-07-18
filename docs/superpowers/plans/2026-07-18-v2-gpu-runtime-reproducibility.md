# V2 GPU Runtime Reproducibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make the v2 OCR image reproducible on a CUDA-capable VM without relying on host-installed Python, cuDNN, or an outdated FFmpeg package.

**Architecture:** Keep the worker's stdout-JSONL contract unchanged. Build from a Python 3.10 Bookworm slim image, install a pinned v2 GPU runtime, install FFmpeg from the Bookworm repository, and use a small shell entrypoint to expose NVIDIA wheel libraries before starting the worker.

**Tech Stack:** Python 3.10, Debian Bookworm, FFmpeg/ffprobe, RapidOCR 3.9.0, ONNX Runtime GPU 1.19.2, NumPy 2.2.6, cuDNN CUDA 12 wheel, Docker NVIDIA runtime.

## Global Constraints

- Production Python remains `>=3.10,<3.13`.
- The worker must continue writing detections only to stdout and progress only to stderr.
- CUDA provider must remain first for both RapidOCR detector and recognizer sessions.
- Legacy OCR containers remain unchanged.
- No CPU fallback is introduced for production OCR.
- Docker builds must fail when the installed FFmpeg lacks `fps_mode` support.

---

### Task 1: Pin the v2 GPU runtime contract

**Files:**
- Create: `containers/ocr-v2/requirements.txt`
- Modify: `tests_v2/adapters/ocr/test_worker_image.py`

**Interfaces:**
- Produces a version-pinned dependency file consumed by the v2 Dockerfile.
- Keeps the existing worker image tests as the contract gate.

- [ ] **Step 1: Write failing tests**

Add tests that require `requirements.txt` to contain exact pins for `numpy==2.2.6`, `onnxruntime-gpu==1.19.2`, `rapidocr==3.9.0`, and `nvidia-cudnn-cu12==9.24.0.43`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `python -m pytest -q tests_v2/adapters/ocr/test_worker_image.py`
Expected: FAIL because the v2 requirements file does not exist.

- [ ] **Step 3: Add the pinned requirements file**

Create the four exact requirement lines above, one package per line, with no unpinned GPU runtime dependency.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `python -m pytest -q tests_v2/adapters/ocr/test_worker_image.py`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add containers/ocr-v2/requirements.txt tests_v2/adapters/ocr/test_worker_image.py && git commit -m "build: pin v2 gpu runtime dependencies"`

### Task 2: Make the Docker image self-contained

**Files:**
- Create: `containers/ocr-v2/entrypoint.sh`
- Modify: `containers/ocr-v2/Dockerfile`
- Modify: `containers/ocr-v2/README.md`
- Test: `tests_v2/adapters/ocr/test_worker_image.py`

**Interfaces:**
- `entrypoint.sh` accepts all existing worker arguments and executes `/app/worker.py` after exporting NVIDIA wheel library paths.
- Docker image continues to expose `ENTRYPOINT ["ytb-vps-v2-ocr"]` and the same stdin/stdout protocol.

- [ ] **Step 1: Write failing Docker contract tests**

Require the Dockerfile to use `python:3.10-slim-bookworm`, install `ffmpeg`, copy and install `containers/ocr-v2/requirements.txt`, copy `entrypoint.sh`, and fail the build when `ffmpeg` does not advertise `fps_mode`. Require the README to document `--gpus all` and the provider smoke command.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `python -m pytest -q tests_v2/adapters/ocr/test_worker_image.py`
Expected: FAIL against the current Python slim Dockerfile.

- [ ] **Step 3: Implement the minimal image and entrypoint**

Use `python:3.10-slim-bookworm`; install only `ca-certificates` and `ffmpeg`; verify `ffmpeg -filters` accepts `fps_mode`; install the pinned requirements; copy v2 source, worker, and entrypoint; set executable permissions; and keep the worker as the entrypoint.

- [ ] **Step 4: Run focused tests and static checks**

Run: `python -m pytest -q tests_v2/adapters/ocr/test_worker_image.py`
Expected: PASS with no legacy files copied.

- [ ] **Step 5: Commit**

`git add containers/ocr-v2/Dockerfile containers/ocr-v2/entrypoint.sh containers/ocr-v2/README.md tests_v2/adapters/ocr/test_worker_image.py && git commit -m "build: make v2 gpu image reproducible"`

### Task 3: Verify the image contract locally and prepare VM acceptance

**Files:**
- Modify: `containers/ocr-v2/README.md`

**Interfaces:**
- Documents the exact build command, GPU run command, provider smoke check, and JSONL fixture check.

- [ ] **Step 1: Run the complete v2 test suite**

Run: `python -m pytest -q tests_v2`
Expected: all available tests pass; environment-only skips remain explicit.

- [ ] **Step 2: Run repository diff and secret gates**

Run: `git diff --check` and the repository's existing secret/tracked-filename checks.
Expected: zero failures and no credential material.

- [ ] **Step 3: Build on a CUDA VM**

Run: `docker build -f containers/ocr-v2/Dockerfile -t ytb-vps-v2-ocr:cuda124 .`
Expected: exit 0 and FFmpeg version >= 5.

- [ ] **Step 4: Run provider and worker smoke checks on the VM**

Run the documented `docker run --rm --gpus all ...` commands with the one-frame BGR fixture and validate JSONL output.

- [ ] **Step 5: Commit documentation if changed**

`git add containers/ocr-v2/README.md && git commit -m "docs: document v2 gpu image acceptance"`
