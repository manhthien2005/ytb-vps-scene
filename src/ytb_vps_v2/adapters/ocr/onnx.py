from __future__ import annotations

import importlib
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from ytb_vps_v2.ports.ocr import OcrProviderReport, require_cuda_provider
from ytb_vps_v2.ports.pipeline import ProviderError


class OnnxOcrSmokeAdapter:
    """Lazy ONNX Runtime provider smoke check.

    The optional runtime is imported only by :meth:`smoke`. Tests and doctor
    commands can inject a provider probe or session factory without installing
    ONNX Runtime.
    """

    def __init__(
        self,
        *,
        model_revision: str,
        model_path: str | Path | None = None,
        provider_probe: Callable[[], Iterable[str]] | None = None,
        session_factory: Callable[..., Any] | None = None,
    ) -> None:
        if type(model_revision) is not str or not model_revision.strip():
            raise ProviderError("OCR model revision must be non-empty")
        self.model_revision = model_revision
        if model_path is not None and not str(model_path).strip():
            raise ProviderError("ONNX model path must be non-empty")
        self.model_path = None if model_path is None else Path(model_path)
        self._provider_probe = provider_probe
        self._session_factory = session_factory

    def _providers(self) -> tuple[str, ...]:
        if self._provider_probe is not None:
            try:
                raw = self._provider_probe()
            except Exception as exc:
                raise ProviderError(f"ONNX provider probe failed: {exc}") from exc
        elif self._session_factory is not None:
            if self.model_path is None:
                raise ProviderError("ONNX model path is required for a session factory")
            try:
                session = self._session_factory(
                    str(self.model_path), providers=["CUDAExecutionProvider"]
                )
                raw = session.get_providers()
            except Exception as exc:  # provider boundary: normalize runtime errors
                raise ProviderError(f"ONNX session initialization failed: {exc}") from exc
        else:
            if self.model_path is None:
                raise ProviderError("ONNX model path is required for smoke")
            try:
                runtime = importlib.import_module("onnxruntime")
                session = runtime.InferenceSession(
                    str(self.model_path), providers=["CUDAExecutionProvider"]
                )
                raw = session.get_providers()
            except ModuleNotFoundError as exc:
                raise ProviderError("onnxruntime is not installed") from exc
            except Exception as exc:
                raise ProviderError(f"ONNX session initialization failed: {exc}") from exc
        try:
            providers = tuple(raw)
        except TypeError as exc:
            raise ProviderError("ONNX runtime returned invalid provider list") from exc
        if not providers or any(type(item) is not str or not item.strip() for item in providers):
            raise ProviderError("ONNX runtime returned invalid provider list")
        return providers

    def smoke(self) -> OcrProviderReport:
        providers = self._providers()
        report = OcrProviderReport(
            backend="onnx",
            providers=providers,
            model_revision=self.model_revision,
        )
        try:
            require_cuda_provider(report)
        except RuntimeError as exc:
            raise ProviderError(str(exc)) from exc
        return report


OnnxOcrProvider = OnnxOcrSmokeAdapter
