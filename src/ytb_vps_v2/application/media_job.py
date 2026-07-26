from __future__ import annotations

import hashlib
import shutil
import threading
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, RegionKind
from ytb_vps_v2.domain.timeline import FrameInterval


class MediaJobError(RuntimeError):
    """Raised when a claimed native media job cannot be completed safely."""


class _LeaseLostError(MediaJobError):
    """The control plane rejected the fenced write (lease lost or state raced)."""


class _LeaseHeartbeat:
    """Renews the lease on a timer while a long phase (download, pipeline, upload)
    runs — the web's 90s TTL is far shorter than a real render, so fixed
    checkpoints alone deterministically lose the lease on long jobs."""

    def __init__(self, renew: Callable[[], bool], interval_seconds: float) -> None:
        self._renew = renew
        self._interval = interval_seconds
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self.cancel_requested = False
        self.error: MediaJobError | None = None

    def _run(self) -> None:
        while not self._stop.wait(self._interval):
            try:
                if self._renew():
                    self.cancel_requested = True
            except MediaJobError as error:
                self.error = error
                return

    def __enter__(self) -> "_LeaseHeartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._stop.set()
        self._thread.join(timeout=10)

    def check(self) -> None:
        if self.error is not None:
            raise self.error


class ControlPlaneMediaClient(Protocol):
    def progress(self, job_id: str, update: dict[str, Any]) -> dict[str, Any]: ...
    def renew(self, job_id: str, fencing_token: int) -> dict[str, Any]: ...
    def output_session(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...
    def complete(self, job_id: str, request: dict[str, Any]) -> dict[str, Any]: ...


def _digest_file(path: Path) -> tuple[int, str]:
    hasher = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            size += len(chunk)
            hasher.update(chunk)
    return size, hasher.hexdigest()


def _rectangle(settings: Mapping[str, Any], name: str, width: int, height: int) -> BlurRegion:
    value = settings.get(name)
    if not isinstance(value, Mapping):
        raise MediaJobError(f"scene setting {name} is invalid")
    try:
        x = float(value["x"])
        y = float(value["y"])
        w = float(value["width"])
        h = float(value["height"])
    except (KeyError, TypeError, ValueError) as error:
        raise MediaJobError(f"scene setting {name} is invalid") from error
    if not all(0 <= item <= 1 for item in (x, y, w, h)) or w <= 0 or h <= 0 or x + w > 1 or y + h > 1:
        raise MediaJobError(f"scene setting {name} is outside the source")
    xmin, ymin = round(x * width), round(y * height)
    xmax, ymax = round((x + w) * width), round((y + h) * height)
    # The web validates only normalized 0..1 rectangles, so a web-valid snapshot can
    # produce sub-8px regions here. Clamp (grow within bounds) instead of failing
    # every attempt deterministically; only a source smaller than 8px is fatal.
    xmin, xmax = _expand_to_minimum(xmin, xmax, 8, width, name)
    ymin, ymax = _expand_to_minimum(ymin, ymax, 8, height, name)
    return BlurRegion(RegionKind.STATIC, FrameInterval(0, 1), BoundingBox(xmin, ymin, xmax, ymax))


def _expand_to_minimum(low: int, high: int, minimum: int, bound: int, name: str) -> tuple[int, int]:
    if high - low >= minimum:
        return low, high
    low = max(0, low - (minimum - (high - low)) // 2)
    high = min(bound, low + minimum)
    low = max(0, high - minimum)
    if high - low < minimum:
        raise MediaJobError(f"scene setting {name} cannot reach {minimum} source pixels")
    return low, high


def scene_blur_regions(settings: Mapping[str, Any], width: int, height: int) -> tuple[BlurRegion, ...]:
    if not isinstance(settings, Mapping):
        raise MediaJobError("scene settings are invalid")
    return (_rectangle(settings, "sourceSubtitle", width, height), _rectangle(settings, "logo", width, height))


class MediaJobExecutor:
    def __init__(
        self,
        client: ControlPlaneMediaClient,
        transfer_factory: Callable[[str], Any],
        pipeline: Callable[[Path, Path, Mapping[str, Any], str], Path],
    ) -> None:
        self.client = client
        self.transfer_factory = transfer_factory
        self.pipeline = pipeline

    @staticmethod
    def _is_lease_lost(error: RuntimeError) -> bool:
        # The real HTTP client raises with .code/.status; injected fakes may return
        # LEASE_LOST bodies instead (handled below). Duck-typed so the application
        # layer never imports the adapter.
        return getattr(error, "code", None) == "LEASE_LOST" or getattr(error, "status", None) == 409

    def _progress(self, job_id: str, update: dict[str, Any]) -> None:
        try:
            response = self.client.progress(job_id, update)
        except RuntimeError as error:
            if self._is_lease_lost(error):
                raise _LeaseLostError("control plane progress update failed: lease lost") from error
            raise MediaJobError("control plane progress update failed") from error
        if not isinstance(response, Mapping):
            raise MediaJobError("control plane progress update failed")
        if response.get("outcome") == "LEASE_LOST" or response.get("code") == "LEASE_LOST":
            raise _LeaseLostError("control plane progress update failed: lease lost")

    def _renew(self, job_id: str, fencing_token: int) -> bool:
        try:
            response = self.client.renew(job_id, fencing_token)
        except RuntimeError as error:
            if self._is_lease_lost(error):
                raise _LeaseLostError("control plane lease renewal failed: lease lost") from error
            raise MediaJobError("control plane lease renewal failed") from error
        if not isinstance(response, Mapping):
            raise MediaJobError("control plane lease renewal failed")
        if response.get("outcome") == "LEASE_LOST" or response.get("code") == "LEASE_LOST":
            raise _LeaseLostError("control plane lease renewal failed: lease lost")
        cancel_requested = response.get("cancelRequested", False)
        if not isinstance(cancel_requested, bool):
            raise MediaJobError("control plane lease renewal failed")
        return cancel_requested

    def _transition_or_cancel(self, job_id: str, fencing_token: int, update: dict[str, Any]) -> bool:
        """Post a state transition; returns True when the job turned out to be
        cancelled and the cancel was acknowledged instead.

        The web flips jobs to CANCEL_REQUESTED immediately, so a transition racing
        that flip is rejected even though the lease is still valid — renew once to
        distinguish the two before treating it as lease loss."""
        try:
            self._progress(job_id, update)
            return False
        except _LeaseLostError:
            if self._renew(job_id, fencing_token):
                self._cancel(job_id, fencing_token, int(update["progressPercent"]))
                return True
            raise

    def _cancel(self, job_id: str, fencing_token: int, progress_percent: int) -> str:
        self._progress(
            job_id,
            {
                "fencingToken": fencing_token,
                "fromState": "CANCEL_REQUESTED",
                "state": "CANCELLED",
                "progressPercent": progress_percent,
                "phase": "cancel",
                "phaseProgressPercent": 100,
                "message": "Cancellation acknowledged",
                "currentPart": 1,
                "totalParts": 1,
            },
        )
        return "CANCELLED"

    def _report_failure(self, job_id: str, fencing_token: int, from_state: str, percent: int) -> None:
        # Best-effort: without this, a failed job sits in DOWNLOADING/OCR/UPLOADING
        # until lease expiry and the failure is invisible to the admin. Failures of
        # the report itself are swallowed (the lease may already be gone).
        try:
            self.client.progress(job_id, {
                "fencingToken": fencing_token,
                "fromState": from_state,
                "state": "FAILED_RETRYABLE",
                "progressPercent": percent,
                "phase": "failed",
                "phaseProgressPercent": 0,
                "message": "Worker execution failed",
                "errorCode": "WORKER_EXECUTION_FAILED",
                "currentPart": 1,
                "totalParts": 1,
            })
        except Exception:
            pass

    @staticmethod
    def _cleanup_workspace(run_root: Path | None) -> None:
        # Terminal outcomes must not leak multi-GB per-job workspaces, and a stale
        # workspace would make the next attempt's download refuse to start.
        if run_root is not None:
            shutil.rmtree(run_root, ignore_errors=True)

    def _heartbeat(self, job_id: str, fencing_token: int) -> _LeaseHeartbeat:
        return _LeaseHeartbeat(lambda: self._renew(job_id, fencing_token), 30.0)

    def execute(self, assignment: Mapping[str, Any], workspace_root: Path) -> str:
        job_id: str | None = None
        fencing_token: int | None = None
        run_root: Path | None = None
        reported_state = "CLAIMED"
        reported_percent = 0
        try:
            job = assignment["job"]
            lease = assignment["lease"]
            execution = assignment["execution"]
            job_id = str(job["id"])
            fencing_token = int(lease["fencingToken"])
            access_token = str(assignment["driveAccessToken"])
            source = execution["source"]
            settings = execution["sceneSettings"]
            project_id = str(execution["projectId"])
            if str(job.get("state")) != "CLAIMED" or not project_id or not access_token:
                raise MediaJobError("assignment is invalid")
            run_root = workspace_root / job_id
            source_path = run_root / "source.mp4"
            expected_size = int(source["sizeBytes"])
            expected_sha256 = str(source["sha256"])
            if self._transition_or_cancel(job_id, fencing_token, {
                "fencingToken": fencing_token,
                "fromState": "CLAIMED",
                "state": "DOWNLOADING",
                "progressPercent": 5,
                "phase": "download",
                "phaseProgressPercent": 0,
                "message": "Downloading source media",
                "currentPart": 1,
                "totalParts": 1,
            }):
                self._cleanup_workspace(run_root)
                return "CANCELLED"
            reported_state, reported_percent = "DOWNLOADING", 5
            transfer = self.transfer_factory(access_token)
            # A retry on the same worker may find the previous attempt's source:
            # reuse it when its digest still matches, otherwise clear it so the
            # fresh download does not refuse the existing destination.
            if source_path.exists():
                size, digest = _digest_file(source_path)
                if size != expected_size or digest != expected_sha256:
                    source_path.unlink()
            if not source_path.exists():
                with self._heartbeat(job_id, fencing_token) as heartbeat:
                    transfer.download_source(str(source["driveFileId"]), source_path, expected_size, expected_sha256)
                heartbeat.check()
                if heartbeat.cancel_requested:
                    self._cancel(job_id, fencing_token, 5)
                    self._cleanup_workspace(run_root)
                    return "CANCELLED"
            if self._transition_or_cancel(job_id, fencing_token, {
                "fencingToken": fencing_token,
                "fromState": "DOWNLOADING",
                "state": "OCR",
                "progressPercent": 20,
                "phase": "process",
                "phaseProgressPercent": 0,
                "message": "Processing source media",
                "currentPart": 1,
                "totalParts": 1,
            }):
                self._cleanup_workspace(run_root)
                return "CANCELLED"
            reported_state, reported_percent = "OCR", 20
            if self._renew(job_id, fencing_token):
                result = self._cancel(job_id, fencing_token, 20)
                self._cleanup_workspace(run_root)
                return result
            with self._heartbeat(job_id, fencing_token) as heartbeat:
                output = self.pipeline(source_path, run_root, settings, job_id)
            heartbeat.check()
            if heartbeat.cancel_requested:
                result = self._cancel(job_id, fencing_token, 20)
                self._cleanup_workspace(run_root)
                return result
            size, checksum = _digest_file(output)
            if self._renew(job_id, fencing_token):
                result = self._cancel(job_id, fencing_token, 90)
                self._cleanup_workspace(run_root)
                return result
            if self._transition_or_cancel(job_id, fencing_token, {
                "fencingToken": fencing_token,
                "fromState": "OCR",
                "state": "UPLOADING",
                "progressPercent": 90,
                "phase": "upload",
                "phaseProgressPercent": 0,
                "message": "Uploading processed media",
                "currentPart": 1,
                "totalParts": 1,
            }):
                self._cleanup_workspace(run_root)
                return "CANCELLED"
            reported_state, reported_percent = "UPLOADING", 90
            session = self.client.output_session(job_id, {"fencingToken": fencing_token, "sizeBytes": size, "checksumSha256": checksum})
            # A cancel observed after the upload starts deliberately finishes the
            # safest already-started operation (documented product decision).
            with self._heartbeat(job_id, fencing_token) as heartbeat:
                transfer.upload_resumable(str(session["sessionUri"]), output, size, checksum)
            heartbeat.check()
            self.client.complete(job_id, {"artifactId": str(session["artifactId"]), "driveFileId": str(session["driveFileId"]), "fencingToken": fencing_token, "sizeBytes": size})
            self._cleanup_workspace(run_root)
            return "COMPLETED"
        except _LeaseLostError:
            raise
        except MediaJobError:
            if job_id is not None and fencing_token is not None:
                self._report_failure(job_id, fencing_token, reported_state, reported_percent)
            raise
        except (KeyError, TypeError, ValueError, OSError) as error:
            if job_id is not None and fencing_token is not None:
                self._report_failure(job_id, fencing_token, reported_state, reported_percent)
            raise MediaJobError("assignment execution failed") from error
