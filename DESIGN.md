# Standalone VPS Video Queue Design

Status: approved for implementation  
Approved: 2026-06-28  
Target: Ubuntu 22.04 NVIDIA VPS with root access, working `nvidia-smi`,
working FFmpeg NVENC, and enough disk for `/srv/ytb-vps`.

## 1. Objective

Build a self-contained application under `tools/vps/` that processes a queue of
videos from input through Chinese subtitle OCR, timing repair, Vietnamese
translation, CapCut text-to-speech, subtitle replacement, encode, validation,
and Google Drive backup.

The application must be deployable independently. It must not import code from
the existing `queue_pipeline/`, `modules/`, `tight_mask_pipeline/`,
`balanced_pipeline/`, or `_external/` directories. Existing behavior may be
studied and ported, but the new package owns all runtime code, tests,
configuration, vendored dependencies, and orchestration it needs.

## 2. Confirmed requirements

- Start the whole workflow with one queue command.
- Process multiple videos sequentially.
- Support inputs up to 1920x1080, 30 FPS, and approximately six hours each.
- Produce Vietnamese subtitles and Vietnamese CapCut TTS audio.
- Prefer reliable restart and resume over processing speed.
- Run on an NVIDIA VPS, including constrained/no-AVX hosts when needed.
- Use Google Drive as durable storage because the VPS disk can disappear.
- Install and manage Codex CLI, the CapCut client, FFmpeg, rclone, models, and
  the two Python runtimes as part of the tool.
- Keep credentials outside Git and outside Google Drive job backups.
- Operate after an SSH session disconnects and restart after an ordinary reboot.

## 3. Explicit non-goals

- No 4K support.
- No concurrent video jobs or concurrent heavyweight workers.
- No completion-time SLA; a long video may take several days.
- No ProPainter, STTN, or RIFE processing in the initial standalone tool.
- No promise that a deleted VPS can recover data created after the latest
  verified Google Drive checkpoint.
- No silent CPU OCR fallback when the legacy GPU runtime fails.
- No automatic upgrades of the pinned CUDA, Paddle, PaddleOCR, or OCR model
  compatibility set.

The subtitle removal behavior follows the current `run_queue.py` workflow:
stable background blur and Vietnamese subtitle rendering, not neural
inpainting.

## 4. Repository structure

```text
tools/vps/
|-- DESIGN.md
|-- README.md
|-- deploy.ps1
|-- install.sh
|-- preflight.sh
|-- run.sh
|-- sync-drive.sh
|-- pyproject.toml
|-- config/
|   `-- config.example.yaml
|-- app/ytb_vps/
|   |-- cli.py
|   |-- queue.py
|   |-- state.py
|   |-- media.py
|   |-- ocr.py
|   |-- translation.py
|   |-- tts.py
|   |-- render.py
|   |-- backup.py
|   `-- vendor/
|-- containers/
|   `-- ocr-legacy/
|-- assets/
|   `-- model-manifest.json
|-- systemd/
|   |-- ytb-vps.service
|   |-- ytb-vps-supervisor.conf
|   `-- ytb-vps-supervisord.conf
`-- tests/
```

Large models, credentials, input videos, work products, and outputs do not live
inside the source directory.

## 5. Installed filesystem layout

```text
/opt/ytb-vps/                    application installed from tools/vps/
/srv/ytb-vps/
|-- input/
|-- work/
|-- output/
|-- logs/
|-- models/
`-- cache/
/etc/ytb-vps/config.yaml         non-secret configuration
/root/.config/ytb-vps/secrets/   credentials, mode 0700; files mode 0600
```

Separating code and state permits application updates without replacing job
checkpoints.

## 6. Runtime architecture

### 6.1 Main application

The controller uses a pinned Python 3.10 environment. It owns queue discovery,
media probing, state, tracking, subtitle generation, Codex translation, CapCut
TTS, rendering, validation, cleanup, logging, and Google Drive operations.

The main environment installs only packages required by this queue. It does not
install the full legacy project requirements or load PyTorch, ProPainter, STTN,
or RIFE.

### 6.2 Legacy OCR worker

OCR runs in a separate pinned container using Python 3.8 and a Paddle GPU build
that supports a no-AVX host CPU. The initial compatibility target is a
Paddle/PaddleOCR/OCR-model set from the Paddle 2.4 generation with a legacy CUDA
runtime suitable for Pascal-era and newer NVIDIA GPUs. Exact image digests,
wheels, and model hashes must be pinned after the target-VPS smoke test.

The container receives only the input path, chunk interval, output path, model
mount, and bounded GPU-memory settings. It never owns queue state.

The host NVIDIA driver is reused. Installing a CUDA 13 toolkit into the app is
neither required nor allowed as a substitute for the legacy OCR runtime.

On a constrained WSL provider that withholds `CAP_NET_ADMIN`, Docker runs with
bridge/NAT/iptables disabled. The OCR worker already uses `--network none`, and
image builds explicitly use host networking.

If that provider blocks namespaces or its legacy CPU cannot execute even the
no-AVX Paddle wheel, the worker uses RapidOCR ONNX models in a dedicated Python
3.10 environment with ONNX Runtime GPU, CUDA 12 and cuDNN 9. Detection and
recognition sessions must report `CUDAExecutionProvider`; CPU fallback is a
hard failure.

### 6.3 Process limits

- One queue instance, enforced with `flock`.
- One video job at a time.
- One OCR worker or one FFmpeg-heavy stage at a time.
- `OMP_NUM_THREADS=1` and `MKL_NUM_THREADS=1`.
- FFmpeg uses at most two threads and defaults to one on memory-sensitive
  stages.
- A 32 GB swap file is created by the installer. Swap is a safety margin, not a
  way to permit unbounded allocations.

## 7. Processing flow

### 7.1 Preflight and ingest

1. Validate the GPU, driver, Docker GPU access, CPU flags, RAM, swap, free disk,
   free inodes, network, credentials, models, and required executables.
2. Probe the input and reject resolution or FPS above the supported limits
   unless explicit normalization can bring it inside the limits.
3. Create a stable job ID from the full-file SHA-256 content fingerprint.
4. Copy the input to Google Drive and verify the remote copy before expensive
   processing begins.

### 7.2 Streaming OCR

The default logical chunk is 300 seconds. The OCR worker seeks to the chunk,
decodes frames sequentially through FFmpeg, and passes one bounded frame at a
time to PaddleOCR. It must not create a full-video PNG directory or hold all
detections in RAM.

Detections are appended to a chunk-local temporary artifact. A successful chunk
is validated and atomically committed into the job database. Temporary frames
or pipes are then closed and removed. A repeatedly failing chunk may be reduced
to 120 seconds. The global frame index and timestamp remain based on the
normalized 30 FPS timeline.

### 7.3 Track and subtitle generation

Raw detections are stored in SQLite and read in frame order. Tracking repairs
short OCR gaps, associates dialogue boxes, and generates:

- raw and cleaned Chinese timelines;
- Vietnamese translation input;
- stable blur regions;
- deterministic render metadata.

Streaming queries and bounded windows replace whole-video dictionaries.

### 7.4 Translation

Codex CLI translates only subtitle text. Translation batches are cached by
input hash. A failed batch is retried and then split in half. Completed batches
remain valid across process restarts and VPS replacement.

Headless authentication uses `codex login --device-auth`. As a fallback, the
user may securely copy `~/.codex/auth.json` from a trusted machine. The auth
file is treated as a password and never enters Git, logs, or Drive backups.

### 7.5 CapCut TTS

Vietnamese subtitles are grouped by time gap, source duration, and character
limit. Each group has a request fingerprint, manifest, audio artifact, retry
state, and checksum. Successful audio groups are never requested again unless
their inputs or selected voice settings change.

The minimal CapCut protocol helper is vendored inside
`tools/vps/app/ytb_vps/vendor/`; its `NOTICE.md` records provenance and the
redistribution caveat. `device.json` is supplied from the secret directory.

### 7.6 Render and validate

Video is rendered in bounded, independently resumable chunks. Chunk boundaries
move to the end of any active subtitle cue so a cue and its TTS group are not
cut. Pillow pre-renders Vietnamese text layers and applies a temporally stable
Gaussian blur; each chunk produces CFR 30 FPS H.264 and passes a full decode
before it is committed.

CapCut TTS audio is composed and AAC-muxed into each render chunk against the
normalized global timeline. Validated audio/video chunks are concatenated
without re-encoding when codec parameters match. Final validation checks
duration, frame rate, frame count, audio presence, complete decode, and
source/job identity before publishing atomically.

### 7.7 Backup and cleanup

After each successful chunk or stage, the controller uses checksum-aware rclone
copy operations for new durable artifacts. Cleanup is allowed only after backup
success. Intermediate render video/audio and fitted TTS are removed after final
backup; raw TTS, OCR, subtitle artifacts, SQLite state and muxed render chunks
remain recoverable. Raw frames exist only in pipes and are never stored.

## 8. State and recovery model

Each job has one `job.sqlite` database. At minimum it stores:

- source fingerprint and media metadata;
- configuration and component version fingerprints;
- stage state;
- OCR chunk state and detection records;
- translation batch cache metadata;
- TTS group metadata;
- render chunk metadata;
- artifact paths, sizes, checksums, and remote-backup status;
- structured error and retry history.

States are `PENDING`, `RUNNING`, `DONE`, and `FAILED`. A transaction may mark an
artifact `DONE` only after its `.part` file is closed, validated, renamed
atomically, and recorded with a checksum.

On startup, stale `RUNNING` work returns to `PENDING`. Recorded `DONE` artifacts
are revalidated. Missing or mismatched artifacts rerun only their owning chunk
and dependent work. One failed video is reported and skipped so later queue
items can continue.

## 9. Google Drive layout and rules

```text
YTB-VPS/
|-- inbox/
|-- jobs/<job-id>/
|   |-- job.sqlite
|   |-- manifests/
|   |-- subtitles/
|   |-- tts/
|   `-- rendered-chunks/
`-- output/
```

Use additive `rclone copy` operations, not destructive `rclone sync` from local
to remote. A local deletion must never delete a valid remote checkpoint.

Backups include inputs, job databases, manifests, subtitle artifacts, TTS
groups, validated render chunks, final outputs, and bounded operational logs.
They exclude Codex credentials, CapCut credentials, rclone tokens, caches, and
reproducible temporary frames.

If the VPS disappears, a new host runs the installer, restores the three
credential sets, and runs `ytb-vps restore`. Resume begins from the last verified
Drive state.

## 10. Service and CLI

The installer creates a systemd unit with restart-on-failure behavior. On a
WSL-style host without systemd it configures Supervisor instead. Job locking
prevents two service instances from processing the same queue.

```bash
sudo tools/vps/install.sh
ytb-vps doctor
ytb-vps auth codex
ytb-vps auth capcut /path/device.json
ytb-vps auth drive
ytb-vps enqueue /path/video.mp4
ytb-vps run
ytb-vps status
ytb-vps logs
ytb-vps stop
ytb-vps retry <job-id>
ytb-vps backup
ytb-vps restore
ytb-vps upgrade <folder-or-git-ref>
```

Upgrade stops at a chunk boundary, backs up state, installs the new application,
runs an explicit SQLite migration, performs `doctor`, and then resumes. It does
not automatically upgrade the legacy OCR compatibility set.

## 11. Security and privacy

- Only subtitle text is sent to Codex and CapCut.
- Videos and work artifacts remain on the VPS and the configured Google Drive.
- Secret directories use mode 0700 and secret files use mode 0600.
- Commands and logs redact tokens, device identifiers, authorization headers,
  and signed URLs.
- The tool never commits credentials or copies them into a job backup.
- Input and output filenames are treated as untrusted data; subprocesses use
  argument arrays rather than shell interpolation.
- Cleanup and restore operations resolve and verify paths before deletion or
  replacement.

## 12. Error handling

- OCR: retry a failed chunk up to two times, then reduce chunk length. Runtime
  incompatibility or `Illegal instruction` is a hard failure.
- Codex: retry, split failed batches, and preserve completed cache entries.
- CapCut: bounded exponential backoff and group-level resume.
- FFmpeg: rerun only the failed render chunk.
- Drive: bounded retry; do not clean up local durable artifacts until remote
  verification succeeds.
- Disk or inode pressure: pause intake and rendering before the reserve is
  exhausted.
- SIGINT/SIGTERM: stop at the nearest safe boundary and commit interruption
  state.

## 13. Test strategy

### Unit tests

Cover chunk planning, global frame/timestamp mapping, state transitions,
dependency invalidation, translation batching, TTS grouping, subtitle merge,
checksum verification, retries, path validation, and secret redaction.

### Integration test

A 30-second fixture runs through probe, OCR, tracking, translation stub or live
smoke, TTS smoke, render, validation, backup staging, and final publish.

### Resume tests

The test harness intentionally terminates OCR, translation, TTS, render, and
backup stages. Restart must reuse completed work and rerun only the interrupted
unit.

### Target-VPS soak test

A 10-minute 1080p30 video is processed while tracking resident RAM, swap, VRAM,
disk, inodes, chunk time, and Drive growth. A multi-hour video may enter the
queue only after the soak test passes.

## 14. Installer acceptance gates

`ytb-vps doctor` must prove all of the following before production work:

1. `nvidia-smi` recognizes the target NVIDIA GPU and expected VRAM.
2. The legacy OCR container sees the GPU.
3. Paddle imports without an illegal instruction.
4. Paddle reports a usable CUDA device.
5. OCR recognizes Chinese text in a known fixture.
6. Codex authenticates and completes a two-entry translation smoke test.
7. CapCut produces a short valid audio file.
8. rclone uploads, downloads, and verifies a checksum.
9. FFmpeg renders and fully decodes a fixture.
10. Disk, inode, RAM, and swap reserves satisfy configured thresholds.

Failure is explicit and blocks production processing. The tool must not silently
select a slower or semantically different fallback.

## 15. Decision log

### D1: Build an independent application in `tools/vps/`

Alternative: import and wrap the existing project modules. Rejected because the
requested deliverable must be independently deployable and maintainable.

### D2: Run the complete pipeline on the VPS

Alternative: keep translation, TTS, or OCR on the Windows workstation. Rejected
because one remote queue command is a confirmed requirement.

### D3: Separate modern orchestration and legacy OCR

Alternative: force one Python environment. Rejected because the no-AVX CPU and
legacy GPU runtime conflict with the modern application dependency set.

### D4: Isolate OCR in a pinned container

Alternative: install legacy CUDA and Paddle directly on Ubuntu 22.04. Rejected
because old runtime libraries would be fragile and could contaminate the main
environment.

### D5: Stream and checkpoint by chunk

Alternative: preserve the existing all-PNG extraction. Rejected because a
six-hour 1080p30 video has approximately 648,000 frames and can exceed local
disk and inode capacity.

### D6: Use SQLite as the job source of truth

Alternative: large JSON manifests. Rejected because streaming queries,
transactional updates, migrations, and bounded memory are required.

### D7: Prefer resume and backup over throughput

Alternative: concurrent jobs and workers. Rejected because 2.91 GB RAM and two
allocated CPU cores cannot support safe parallel work.

### D8: Back up every committed unit to Google Drive

Alternative: upload only the final output. Rejected because the VPS disk is
ephemeral and processing may run for days.

### D9: Keep credentials outside source and backups

Alternative: package credentials for one-command restore. Rejected because
Codex auth, CapCut device credentials, and rclone tokens are password-equivalent
secrets.

### D10: Preserve stable-blur behavior

Alternative: add ProPainter/STTN/RIFE. Deferred because it materially expands
VRAM, runtime, implementation, and validation risk and is not used by the
current queue path.

## 16. Accepted risks

- The legacy Paddle/CUDA set may still fail on the provider's driver. The smoke
  gate prevents wasting time on a long input when this happens.
- CapCut's third-party interface may change, throttle, or invalidate the device
  credential.
- Codex quotas or authentication can pause translation.
- Google Drive quotas and network latency can delay checkpoint completion.
- A deleted VPS can lose work since the most recent verified backup.
- The old CPU can make processing take multiple days.
- Stable blur does not provide neural inpainting quality.

## 17. Reference constraints

- PaddlePaddle 2.6 Linux packages require AVX and no longer provide no-AVX
  packages: <https://www.paddlepaddle.org.cn/documentation/docs/en/2.6/install/pip/linux-pip_en.html>
- PaddlePaddle 2.4 documents a Python 3.8 GPU no-AVX package path:
  <https://www.paddlepaddle.org.cn/documentation/docs/en/2.4/install/pip/linux-pip_en.html>
- NVIDIA lists legacy Pascal GPUs such as the GeForce GTX 1070 as compute
  capability 6.1:
  <https://developer.nvidia.com/cuda/gpus/legacy>
- Codex documents device-code login and secure headless credential transfer:
  <https://developers.openai.com/codex/auth>

## 18. Implementation handoff

Implementation should proceed in gated increments:

1. Skeleton, configuration, installer, and preflight.
2. Legacy OCR image and one-image target-VPS proof.
3. SQLite state and streaming OCR chunks.
4. Tracking and subtitle artifacts.
5. Codex translation and CapCut group cache.
6. Chunk render, concat, and validation.
7. Drive backup/restore and systemd service.
8. Resume fault injection, 30-second integration test, and 10-minute soak test.

No production-length video should run until the compatibility proof and soak
test pass.
