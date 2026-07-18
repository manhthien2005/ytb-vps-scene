# v2 OCR worker contract

This image is the stdout-JSONL boundary for the v2 OCR pipeline. It accepts
bounded raw BGR frames on stdin and writes only detection JSONL to stdout.
Progress and completion messages are written to stderr.

The base image intentionally installs only the v2 package. A target GPU image
must add pinned `rapidocr`, NumPy, and `onnxruntime-gpu` wheels before use;
missing optional runtime dependencies fail explicitly at startup. The audited
legacy OCR images remain unchanged and are not imported by this worker.
