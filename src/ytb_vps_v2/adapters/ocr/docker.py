from __future__ import annotations

import json
import re
import subprocess
from collections.abc import Callable
from typing import Any

from ytb_vps_v2.ports.ocr import OcrProviderReport
from ytb_vps_v2.ports.pipeline import ProviderError


_UNSAFE_IMAGE = re.compile(r"[\s;&|<>$`(){}\[\]'\"]")


class DockerOcrSmokeAdapter:
    """Shell-free Docker worker smoke adapter with a shared JSON report."""

    def __init__(
        self,
        image: str,
        *,
        runner: Callable[[tuple[str, ...]], str | bytes | Any] | None = None,
    ) -> None:
        if type(image) is not str or not image.strip() or image != image.strip():
            raise ProviderError("Docker OCR image must be non-empty and trimmed")
        if image.startswith("-") or _UNSAFE_IMAGE.search(image):
            raise ProviderError("Docker OCR image contains unsafe characters")
        self.image = image
        self._runner = runner

    def build_argv(self) -> tuple[str, ...]:
        return ("docker", "run", "--rm", "--network", "none", self.image, "--smoke")

    def _run(self, argv: tuple[str, ...]) -> str | bytes:
        if self._runner is not None:
            try:
                result = self._runner(argv)
            except Exception as exc:
                raise ProviderError(f"Docker OCR smoke failed: {exc}") from exc
            if isinstance(result, (str, bytes)):
                return result
            returncode = getattr(result, "returncode", 0)
            if returncode != 0:
                raise ProviderError(f"Docker OCR smoke exited with status {returncode}")
            output = getattr(result, "stdout", None)
            if not isinstance(output, (str, bytes)):
                raise ProviderError("Docker OCR runner returned no smoke output")
            return output
        try:
            completed = subprocess.run(
                list(argv),
                check=False,
                shell=False,
                capture_output=True,
                text=True,
            )
        except OSError as exc:
            raise ProviderError(f"Docker executable unavailable: {exc}") from exc
        if completed.returncode != 0:
            raise ProviderError(
                f"Docker OCR smoke exited with status {completed.returncode}"
            )
        return completed.stdout

    def smoke(self) -> OcrProviderReport:
        raw = self._run(self.build_argv())
        try:
            payload = json.loads(raw)
        except (TypeError, ValueError, json.JSONDecodeError) as exc:
            raise ProviderError("Docker OCR smoke output is not valid JSON") from exc
        if type(payload) is not dict:
            raise ProviderError("Docker OCR smoke JSON must be an object")
        try:
            backend = payload["backend"]
            providers = tuple(payload["providers"])
            model_revision = payload["model_revision"]
            return OcrProviderReport(backend, providers, model_revision)
        except (KeyError, TypeError, ValueError) as exc:
            raise ProviderError("Docker OCR smoke JSON does not match OCR report") from exc


DockerOcrProvider = DockerOcrSmokeAdapter
