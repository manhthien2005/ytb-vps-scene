from __future__ import annotations

import hashlib
import shutil
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from fractions import Fraction
from pathlib import Path
from typing import Any, Protocol

from ytb_vps_v2.domain.models import BlurRegion, BoundingBox, RegionKind
from ytb_vps_v2.domain.timeline import FrameInterval


class MediaJobError(RuntimeError):
    """Raised when a claimed native media job cannot be completed safely."""


class _LeaseLostError(MediaJobError):
    """The control plane rejected the fenced write (lease lost or state raced)."""


@dataclass(frozen=True, slots=True)
class MediaOutput:
    part_index: int
    part_count: int
    path: Path

    def __post_init__(self) -> None:
        if (
            type(self.part_index) is not int
            or type(self.part_count) is not int
            or not 1 <= self.part_index <= self.part_count <= 999
        ):
            raise MediaJobError("media output Part metadata is invalid")
        if not isinstance(self.path, Path):
            raise MediaJobError("media output path is invalid")


def _media_outputs(value: object) -> tuple[MediaOutput, ...]:
    if (
        type(value) is not tuple
        or not value
        or any(type(item) is not MediaOutput for item in value)
    ):
        raise MediaJobError(
            "pipeline outputs must be a non-empty MediaOutput tuple"
        )
    outputs = value
    count = len(outputs)
    if (
        count > 999
        or tuple(item.part_index for item in outputs)
        != tuple(range(1, count + 1))
        or any(item.part_count != count for item in outputs)
        or len({item.path for item in outputs}) != count
        or any(not item.path.is_file() for item in outputs)
    ):
        raise MediaJobError(
            "pipeline output descriptors are incomplete or malformed"
        )
    return outputs


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


def _rectangle_box(
    value: Mapping[str, Any],
    width: int,
    height: int,
    name: str,
) -> BoundingBox:
    try:
        x, y = float(value["x"]), float(value["y"])
        w, h = float(value["width"]), float(value["height"])
    except (KeyError, TypeError, ValueError) as error:
        raise MediaJobError(f"scene region {name} is invalid") from error
    if not all(0 <= item <= 1 for item in (x, y, w, h)) or w <= 0 or h <= 0:
        raise MediaJobError(f"scene region {name} is outside the source")
    if x + w > 1 or y + h > 1:
        raise MediaJobError(f"scene region {name} is outside the source")
    xmin, xmax = _expand_to_minimum(
        round(x * width),
        round((x + w) * width),
        8,
        width,
        name,
    )
    ymin, ymax = _expand_to_minimum(
        round(y * height),
        round((y + h) * height),
        8,
        height,
        name,
    )
    return BoundingBox(xmin, ymin, xmax, ymax)


def _expand_to_minimum(low: int, high: int, minimum: int, bound: int, name: str) -> tuple[int, int]:
    if high - low >= minimum:
        return low, high
    low = max(0, low - (minimum - (high - low)) // 2)
    high = min(bound, low + minimum)
    low = max(0, high - minimum)
    if high - low < minimum:
        raise MediaJobError(f"scene setting {name} cannot reach {minimum} source pixels")
    return low, high


_MASK_KINDS = {"blur", "channelLogo"}
_LEGACY_KIND_MAP = {
    "sourceSubtitle": "blur",
    "logo": "channelLogo",
    "custom": "blur",
}
_CANONICAL_VOICE = "BV074_streaming"
_VOICE_ALIASES = {
    "vi-VN-HoaiMyNeural": _CANONICAL_VOICE,
    "vi-VN-NamMinhNeural": _CANONICAL_VOICE,
}


@dataclass(frozen=True, slots=True)
class SceneRenderProjection:
    blur_regions: tuple[BlurRegion, ...]
    tts_rate: Fraction

    def __post_init__(self) -> None:
        if type(self.blur_regions) is not tuple or any(
            type(region) is not BlurRegion
            for region in self.blur_regions
        ):
            raise MediaJobError("scene render regions are invalid")
        if (
            not isinstance(self.tts_rate, Fraction)
            or not Fraction(4, 5) <= self.tts_rate <= Fraction(6, 5)
        ):
            raise MediaJobError("scene TTS rate must be between 0.8 and 1.2")


def _regions_from_settings(
    settings: Mapping[str, Any],
) -> list[Mapping[str, Any]]:
    if isinstance(settings.get("regions"), list):
        return [
            item
            for item in settings["regions"]
            if isinstance(item, Mapping)
        ]
    blur = settings.get("blur")
    if isinstance(blur, Mapping) and isinstance(blur.get("regions"), list):
        return [
            {
                **item,
                "kind": _LEGACY_KIND_MAP.get(
                    str(item.get("kind")),
                    "blur",
                ),
            }
            for item in blur["regions"]
            if isinstance(item, Mapping)
        ]
    legacy = []
    for name, kind in (
        ("sourceSubtitle", "blur"),
        ("logo", "channelLogo"),
    ):
        rectangle = settings.get(name)
        if isinstance(rectangle, Mapping):
            legacy.append(
                {
                    "kind": kind,
                    "label": name,
                    "enabled": True,
                    "rectangle": rectangle,
                }
            )
    if legacy:
        return legacy
    raise MediaJobError("scene settings contain no regions")


def _time_intervals(
    value: object,
    *,
    frame_count: int,
) -> tuple[FrameInterval, ...]:
    if value is None:
        return (FrameInterval(0, frame_count),)
    if not isinstance(value, list):
        raise MediaJobError("scene region time ranges are invalid")
    intervals = []
    for item in value:
        if not isinstance(item, Mapping):
            raise MediaJobError("scene region time range is invalid")
        try:
            start = Fraction(str(item["startSeconds"]))
            end = Fraction(str(item["endSeconds"]))
        except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
            raise MediaJobError("scene region time range is invalid") from error
        if start < 0 or end <= start:
            raise MediaJobError("scene region time range is invalid")
        start_value = start * 30
        end_value = end * 30
        start_frame = start_value.numerator // start_value.denominator
        end_frame = -(-end_value.numerator // end_value.denominator)
        if start_frame >= frame_count or end_frame > frame_count:
            raise MediaJobError("scene region time range is outside the media timeline")
        intervals.append(FrameInterval(start_frame, end_frame))
    return tuple(intervals)


def scene_render_projection(
    settings: Mapping[str, Any],
    width: int,
    height: int,
    *,
    frame_count: int,
) -> SceneRenderProjection:
    if not isinstance(settings, Mapping):
        raise MediaJobError("scene settings are invalid")
    if not isinstance(frame_count, int) or isinstance(frame_count, bool) or frame_count < 1:
        raise MediaJobError("scene regions need a positive frame count")
    voice = settings.get("voice", _CANONICAL_VOICE)
    if not isinstance(voice, str):
        raise MediaJobError("scene TTS voice is invalid")
    if _VOICE_ALIASES.get(voice, voice) != _CANONICAL_VOICE:
        raise MediaJobError("scene TTS voice is unsupported")
    rate = settings.get("rate", 1)
    if isinstance(rate, bool):
        raise MediaJobError("scene TTS rate is invalid")
    try:
        tts_rate = Fraction(str(rate))
    except (TypeError, ValueError, ZeroDivisionError) as error:
        raise MediaJobError("scene TTS rate is invalid") from error
    if not Fraction(4, 5) <= tts_rate <= Fraction(6, 5):
        raise MediaJobError("scene TTS rate must be between 0.8 and 1.2")
    regions = []
    for index, item in enumerate(_regions_from_settings(settings)):
        if (
            str(item.get("kind")) not in _MASK_KINDS
            or not item.get("enabled", True)
        ):
            continue
        rectangle = item.get("rectangle")
        if not isinstance(rectangle, Mapping):
            raise MediaJobError(f"scene region {index} has no rectangle")
        box = _rectangle_box(
            rectangle,
            width,
            height,
            str(item.get("label") or index),
        )
        regions.extend(
            BlurRegion(RegionKind.STATIC, interval, box)
            for interval in _time_intervals(
                item.get("timeRanges"),
                frame_count=frame_count,
            )
        )
    return SceneRenderProjection(tuple(regions), tts_rate)


def scene_blur_regions(
    settings: Mapping[str, Any],
    width: int,
    height: int,
    *,
    frame_count: int,
) -> tuple[BlurRegion, ...]:
    return scene_render_projection(
        settings,
        width,
        height,
        frame_count=frame_count,
    ).blur_regions


class MediaJobExecutor:
    def __init__(
        self,
        client: ControlPlaneMediaClient,
        transfer_factory: Callable[[str], Any],
        pipeline: Callable[
            [Path, Path, Mapping[str, Any], str],
            tuple[MediaOutput, ...],
        ],
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
                self._cancel(
                    job_id,
                    fencing_token,
                    int(update["progressPercent"]),
                    int(update.get("currentPart", 1)),
                    int(update.get("totalParts", 1)),
                )
                return True
            raise

    def _cancel(
        self,
        job_id: str,
        fencing_token: int,
        progress_percent: int,
        current_part: int = 1,
        total_parts: int = 1,
    ) -> str:
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
                "currentPart": current_part,
                "totalParts": total_parts,
            },
        )
        return "CANCELLED"

    def _output_session(
        self,
        job_id: str,
        request: dict[str, Any],
    ) -> Mapping[str, Any]:
        try:
            response = self.client.output_session(job_id, request)
        except RuntimeError as error:
            if self._is_lease_lost(error):
                raise _LeaseLostError(
                    "control plane output session failed: lease lost"
                ) from error
            raise MediaJobError(
                "control plane output session failed"
            ) from error
        if not isinstance(response, Mapping):
            raise MediaJobError("control plane output session failed")
        return response

    def _complete_output(
        self,
        job_id: str,
        request: dict[str, Any],
    ) -> Mapping[str, Any]:
        try:
            response = self.client.complete(job_id, request)
        except RuntimeError as error:
            if self._is_lease_lost(error):
                raise _LeaseLostError(
                    "control plane completion failed: lease lost"
                ) from error
            raise MediaJobError(
                "control plane completion failed"
            ) from error
        if not isinstance(response, Mapping):
            raise MediaJobError("control plane completion failed")
        return response

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
                pipeline_outputs = self.pipeline(
                    source_path,
                    run_root,
                    settings,
                    job_id,
                )
            heartbeat.check()
            if heartbeat.cancel_requested:
                result = self._cancel(job_id, fencing_token, 20)
                self._cleanup_workspace(run_root)
                return result
            outputs = _media_outputs(pipeline_outputs)
            total_parts = len(outputs)
            if self._renew(job_id, fencing_token):
                result = self._cancel(
                    job_id,
                    fencing_token,
                    90,
                    1,
                    total_parts,
                )
                self._cleanup_workspace(run_root)
                return result
            for position, output in enumerate(outputs, start=1):
                if position > 1 and self._renew(
                    job_id,
                    fencing_token,
                ):
                    progress = 90 + (
                        (position - 1) * 9
                    ) // total_parts
                    result = self._cancel(
                        job_id,
                        fencing_token,
                        progress,
                        position,
                        total_parts,
                    )
                    self._cleanup_workspace(run_root)
                    return result
                progress = 90 + (
                    (position - 1) * 9
                ) // total_parts
                if self._transition_or_cancel(
                    job_id,
                    fencing_token,
                    {
                        "fencingToken": fencing_token,
                        "fromState": (
                            "OCR"
                            if position == 1
                            else "UPLOADING"
                        ),
                        "state": "UPLOADING",
                        "progressPercent": progress,
                        "phase": "upload",
                        "phaseProgressPercent": (
                            (position - 1) * 100
                        )
                        // total_parts,
                        "message": (
                            f"Uploading output Part "
                            f"{position}/{total_parts}"
                        ),
                        "currentPart": position,
                        "totalParts": total_parts,
                    },
                ):
                    self._cleanup_workspace(run_root)
                    return "CANCELLED"
                reported_state = "UPLOADING"
                reported_percent = progress
                size, checksum = _digest_file(output.path)
                session = self._output_session(
                    job_id,
                    {
                        "fencingToken": fencing_token,
                        "partIndex": output.part_index,
                        "partCount": output.part_count,
                        "sizeBytes": size,
                        "checksumSha256": checksum,
                    },
                )
                status = session.get("status")
                artifact_id = session.get("artifactId")
                drive_file_id = session.get("driveFileId")
                if (
                    status not in {"READY", "UPLOAD"}
                    or type(artifact_id) is not str
                    or not artifact_id
                    or type(drive_file_id) is not str
                    or not drive_file_id
                ):
                    raise MediaJobError(
                        "control plane output session is invalid"
                    )
                if status == "READY":
                    if position == total_parts:
                        self._cleanup_workspace(run_root)
                        return "COMPLETED"
                    continue
                session_uri = session.get("sessionUri")
                expires_at = session.get("expiresAt")
                if (
                    type(session_uri) is not str
                    or not session_uri
                    or type(expires_at) is not str
                    or not expires_at
                ):
                    raise MediaJobError(
                        "control plane upload session is invalid"
                    )
                # A cancel observed after the upload starts deliberately
                # finishes the safest already-started operation.
                with self._heartbeat(
                    job_id,
                    fencing_token,
                ) as heartbeat:
                    transfer.upload_resumable(
                        session_uri,
                        output.path,
                        size,
                        checksum,
                    )
                heartbeat.check()
                completed = self._complete_output(
                    job_id,
                    {
                        "artifactId": artifact_id,
                        "driveFileId": drive_file_id,
                        "fencingToken": fencing_token,
                        "partIndex": output.part_index,
                        "partCount": output.part_count,
                        "sizeBytes": size,
                    },
                )
                expected_outcome = (
                    "COMPLETED"
                    if position == total_parts
                    else "PART_COMPLETED"
                )
                if completed.get("outcome") != expected_outcome:
                    raise MediaJobError(
                        "control plane completion outcome is invalid"
                    )
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
