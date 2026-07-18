from __future__ import annotations

import subprocess
from collections.abc import Callable

from ytb_vps_v2.adapters.ocr.docker import _UNSAFE_IMAGE
from ytb_vps_v2.adapters.ocr.stream import parse_worker_jsonl
from ytb_vps_v2.ports.ocr import CoordinateTransform, OcrDetection
from ytb_vps_v2.ports.pipeline import ProviderError


class DockerOcrChunkDetector:
    """Run one shell-free Docker OCR worker for a bounded raw-frame chunk."""

    def __init__(
        self,
        image: str,
        *,
        runner: Callable[[tuple[str, ...], bytes, int], tuple[int, bytes]] | None = None,
        timeout_seconds: int = 300,
        max_output_bytes: int = 16 * 1024 * 1024,
    ) -> None:
        if type(image) is not str or not image.strip() or image != image.strip():
            raise ProviderError("Docker OCR image must be non-empty and trimmed")
        if image.startswith("-") or _UNSAFE_IMAGE.search(image):
            raise ProviderError("Docker OCR image contains unsafe characters")
        if type(timeout_seconds) is not int or timeout_seconds <= 0:
            raise ProviderError("Docker OCR timeout must be positive")
        if type(max_output_bytes) is not int or max_output_bytes <= 0:
            raise ProviderError("Docker OCR output limit must be positive")
        self.image = image
        self.runner = runner
        self.timeout_seconds = timeout_seconds
        self.max_output_bytes = max_output_bytes

    def build_argv(
        self,
        *,
        width: int,
        height: int,
        start_frame: int,
        expected_frames: int,
        frame_step: int,
    ) -> tuple[str, ...]:
        return (
            "docker", "run", "--rm", "--network", "none", self.image,
            "--width", str(width), "--height", str(height),
            "--start-frame", str(start_frame), "--expected-frames", str(expected_frames),
            "--frame-step", str(frame_step), "--output", "-",
        )

    def _run(self, argv: tuple[str, ...], payload: bytes) -> bytes:
        if self.runner is not None:
            try:
                code, output = self.runner(argv, payload, self.timeout_seconds)
            except Exception as exc:
                raise ProviderError(f"Docker OCR chunk failed: {exc}") from exc
            if code != 0:
                raise ProviderError(f"Docker OCR chunk exited with status {code}")
            if not isinstance(output, bytes):
                raise ProviderError("Docker OCR chunk returned non-bytes output")
            return output
        try:
            completed = subprocess.run(
                list(argv), input=payload, capture_output=True, timeout=self.timeout_seconds,
                check=False, shell=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise ProviderError("Docker OCR chunk timed out") from exc
        except OSError as exc:
            raise ProviderError(f"Docker OCR executable unavailable: {exc}") from exc
        if completed.returncode != 0:
            raise ProviderError(f"Docker OCR chunk exited with status {completed.returncode}")
        return completed.stdout

    def run_chunk(
        self,
        payload: bytes,
        *,
        width: int,
        height: int,
        start_frame: int,
        frame_step: int,
        expected_frames: int,
        transform: CoordinateTransform,
    ) -> tuple[OcrDetection, ...]:
        if not isinstance(payload, bytes) or not payload:
            raise ProviderError("Docker OCR chunk payload must be non-empty bytes")
        argv = self.build_argv(
            width=width, height=height, start_frame=start_frame,
            expected_frames=expected_frames, frame_step=frame_step,
        )
        output = self._run(argv, payload)
        if len(output) > self.max_output_bytes:
            raise ProviderError("Docker OCR chunk output exceeds limit")
        try:
            return parse_worker_jsonl(
                output, width=width, height=height, start_frame=start_frame,
                frame_step=frame_step, transform=transform,
                expected_frames=expected_frames,
            )
        except ValueError as exc:
            raise ProviderError("Docker OCR chunk JSONL is invalid") from exc
