from __future__ import annotations

import hashlib
import re
import tempfile
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Callable, TypeAlias, TypeVar

from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.invalidation import plan_invalidation
from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    CheckpointRecord,
    FileDigest,
    ManifestEntry,
    VerifiedInputArchive,
    parse_manifest_bytes,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.fingerprints import Fingerprint, StageConfigFingerprint
from ytb_vps_v2.domain.invalidation import STAGE_ORDER
from ytb_vps_v2.domain.models import (
    Artifact,
    BlurRegion,
    JobId,
    Part,
    RegionKind,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.pipeline import (
    OCR_ARTIFACT_PATH,
    PIPELINE_ARTIFACT_PATHS,
    PUBLICATION_ARTIFACT_PATH,
    RENDER_PLAN_ARTIFACT_PATH,
    TTS_ARTIFACT_PATH,
    CheckpointDocument,
    MediaDocument,
    OcrDocument,
    PipelineDocument,
    PublicationDocument,
    RenderPlanDocument,
    RenderRequest,
    TrackDocument,
    TranslationDocument,
    TtsDocument,
    canonical_document_bytes,
    parse_checkpoint_document_bytes,
    parse_media_document_bytes,
    parse_ocr_document_bytes,
    parse_publication_document_bytes,
    parse_render_plan_document_bytes,
    parse_track_document_bytes,
    parse_translation_document_bytes,
    parse_tts_document_bytes,
)
from ytb_vps_v2.domain.restore import RemoteObjectEvidence
from ytb_vps_v2.domain.timeline import FrameInterval
from ytb_vps_v2.ports.backup import BackupStoreError
from ytb_vps_v2.ports.pipeline import (
    ArtifactWriter,
    ArtifactWriterFactory,
    FileDigestVerifier,
    MediaPipeline,
    OcrProvider,
    PartPublisher,
    PartPublisherFactory,
    TranslationProvider,
    TtsProvider,
    TtsSynthesis,
)
from ytb_vps_v2.ports.state import StateRepository


class OfflineSliceError(RuntimeError):
    """Raised when the deterministic offline slice cannot safely complete."""


class OfflineSliceInterrupted(RuntimeError):
    """Raised by deterministic interruption injection in restart tests."""


class FreshWorkspaceRequired(OfflineSliceError):
    """Raised when damaged committed output has no safe fresh destination."""


class InterruptionPoint(str, Enum):
    BEFORE_PROVIDER = "before_provider"
    AFTER_PROVIDER = "after_provider"
    BEFORE_FILESYSTEM_PUBLICATION = "before_filesystem_publication"
    AFTER_FILESYSTEM_PUBLICATION = "after_filesystem_publication"
    AFTER_SQLITE_COMMIT = "after_sqlite_commit"


InterruptionHook = Callable[[StageName, InterruptionPoint], None]


_DOCUMENT_TYPES = (
    MediaDocument,
    OcrDocument,
    TrackDocument,
    TranslationDocument,
    TtsDocument,
    RenderPlanDocument,
    PublicationDocument,
    CheckpointDocument,
)
_PATHS = tuple(PIPELINE_ARTIFACT_PATHS[item] for item in _DOCUMENT_TYPES)
_NAMES = tuple(f"{stage.value.lower()}-document" for stage in STAGE_ORDER)
_UNIT_KEYS = tuple(stage.value.lower() for stage in STAGE_ORDER)
_TTS_AUDIO_PATH = PurePosixPath("artifacts/tts/voice.wav")
_RENDERED_PATH = PurePosixPath("artifacts/render/rendered.mp4")
_PUBLISHED_PATH = PurePosixPath("published/part-001.mp4")
_SIDE_NAMES = {
    StageName.TTS: "tts-audio",
    StageName.RENDER: "rendered-video",
    StageName.PUBLISH: "published-part-001",
}
_PART = Part(1, 1, FrameInterval(0, 900), (0,))
_VERIFY_METHOD = "sha256-readback"
_MAX_DOCUMENT_BYTES = 4 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class OfflineSliceRequest:
    job_id: JobId
    source: Path
    verified_input: VerifiedInputArchive
    config_fingerprints: tuple[StageConfigFingerprint, ...]
    workspace_root: Path
    snapshot_dir: Path
    output_has_audio: bool
    at: str
    verification_observed_at: int
    proof_checkpoint_id: str = "offline-proof-v1"
    final_checkpoint_id: str = "offline-final-v1"
    fresh_workspace_root: Path | None = None
    # User-authored static masks from the scene editor.  These are intentionally
    # immutable for one run and are combined with OCR-derived dynamic masks.
    blur_regions: tuple[BlurRegion, ...] = ()


@dataclass(frozen=True, slots=True)
class OfflineSliceResult:
    job_id: JobId
    workspace_root: Path
    work_units: tuple[WorkUnit, ...]
    artifacts: tuple[Artifact, ...]
    publication: PublicationDocument
    checkpoint: CheckpointDocument
    proof_manifest: CheckpointManifest
    final_manifest: CheckpointManifest
    final_checkpoint: CheckpointRecord


@dataclass(frozen=True, slots=True)
class PreparedRender:
    request: RenderRequest
    temporary_path: Path


@dataclass(frozen=True, slots=True)
class PreparedPublish:
    plan: RenderPlanDocument
    source: Path


@dataclass(frozen=True, slots=True)
class PreparedBackup:
    publication: PublicationDocument
    proof: CheckpointManifest | None
    record: CheckpointRecord


PreparedStage: TypeAlias = (
    PipelineDocument | TtsSynthesis | PreparedRender | PreparedPublish | PreparedBackup
)


@dataclass(frozen=True, slots=True)
class ResumeState:
    workspace: Path
    documents: dict[StageName, PipelineDocument]
    proof_repair_token: str | None


_DocumentT = TypeVar("_DocumentT", bound=PipelineDocument)


class OfflineSliceRunner:
    def __init__(
        self,
        state: StateRepository,
        checkpoints: CheckpointPublisher,
        media: MediaPipeline,
        ocr: OcrProvider,
        translation: TranslationProvider,
        tts: TtsProvider,
        artifact_writers: ArtifactWriterFactory,
        part_publishers: PartPublisherFactory,
        files: FileDigestVerifier,
        interruption: InterruptionHook | None = None,
    ) -> None:
        self.state = state
        self.checkpoints = checkpoints
        self.media = media
        self.ocr = ocr
        self.translation = translation
        self.tts = tts
        self.artifact_writers = artifact_writers
        self.part_publishers = part_publishers
        self.files = files
        self.interruption = interruption

    def run(self, request: OfflineSliceRequest) -> OfflineSliceResult:
        self._validate_request(request)
        try:
            if self.files.digest(request.source) != request.verified_input.archive.digest:
                raise OfflineSliceError("Archived input failed exact digest verification")
            self.state.recover_stale_work(request.at)
            self.state.create_job(
                request.job_id,
                Fingerprint(request.verified_input.source.digest.sha256),
                request.config_fingerprints,
                request.at,
            )
            self.state.record_verified_input(request.job_id, request.verified_input)
            self._ensure_units(request)
            resumed = self._resume_workspace(request)
            workspace = resumed.workspace
            documents = resumed.documents
            writer = self.artifact_writers(workspace)
            publisher = self.part_publishers(workspace)

            for index, stage in enumerate(STAGE_ORDER):
                unit = self.state.get_work_unit(request.job_id, _UNIT_KEYS[index])
                if unit.status is WorkStatus.SUCCEEDED:
                    if stage not in documents:
                        raise OfflineSliceError(
                            f"Succeeded stage lacks verified canonical output: {stage.value}"
                        )
                    continue
                self.state.start_work_unit(request.job_id, unit.key, request.at)
                self._hit(stage, InterruptionPoint.BEFORE_PROVIDER)
                prepared: PreparedStage | None = None
                try:
                    prepared = self._prepare(
                        stage,
                        request,
                        workspace,
                        documents,
                        writer,
                        resumed.proof_repair_token,
                    )
                    self._hit(stage, InterruptionPoint.AFTER_PROVIDER)
                    self._hit(stage, InterruptionPoint.BEFORE_FILESYSTEM_PUBLICATION)
                    document = self._publish_prepared(
                        stage,
                        prepared,
                        writer,
                        publisher,
                    )
                    primary_entry = writer.write_bytes(
                        _PATHS[index],
                        canonical_document_bytes(document),
                    )
                    self._hit(stage, InterruptionPoint.AFTER_FILESYSTEM_PUBLICATION)
                    artifacts = self._stage_artifacts(
                        stage,
                        index,
                        document,
                        primary_entry,
                    )
                    self.state.commit_artifacts(
                        request.job_id,
                        unit.key,
                        artifacts,
                        request.at,
                    )
                    documents[stage] = document
                    self._hit(stage, InterruptionPoint.AFTER_SQLITE_COMMIT)
                except OfflineSliceInterrupted:
                    self._discard_prepared(prepared)
                    raise
                except BaseException as exc:
                    self._discard_prepared(prepared)
                    current = self.state.get_work_unit(request.job_id, unit.key)
                    if current.status is WorkStatus.RUNNING:
                        self.state.fail_work_unit(
                            request.job_id,
                            unit.key,
                            type(exc).__name__[:128],
                            str(exc)[:4096] or "offline stage failed",
                            request.at,
                        )
                    raise OfflineSliceError(
                        f"Offline stage failed: {stage.value}"
                    ) from exc

            checkpoint_document = self._document(
                documents,
                StageName.BACKUP,
                CheckpointDocument,
            )
            proof_id = checkpoint_document.checkpoint_id
            final_base = self._effective_checkpoint_id(
                request,
                request.final_checkpoint_id,
                STAGE_ORDER,
            )
            proof = self.checkpoints.publish(
                request.job_id,
                proof_id,
                workspace,
                request.snapshot_dir,
                request.at,
                verification_observed_at=request.verification_observed_at,
                verification_method=_VERIFY_METHOD,
            )
            proof_record = self._checkpoint_record(request.job_id, proof_id)
            self._verify_checkpoint_record(
                proof_record,
                request.verification_observed_at,
            )
            final_id = self._checkpoint_id_for_publication(
                request.job_id,
                final_base,
                request.verification_observed_at,
            )
            final = self.checkpoints.publish(
                request.job_id,
                final_id,
                workspace,
                request.snapshot_dir,
                request.at,
                verification_observed_at=request.verification_observed_at,
                verification_method=_VERIFY_METHOD,
            )
            final_record = self._checkpoint_record(request.job_id, final_id)
            self._verify_checkpoint_record(
                final_record,
                request.verification_observed_at,
            )
            return OfflineSliceResult(
                request.job_id,
                workspace,
                tuple(
                    self.state.get_work_unit(request.job_id, key)
                    for key in _UNIT_KEYS
                ),
                self.state.valid_artifacts(request.job_id),
                self._document(documents, StageName.PUBLISH, PublicationDocument),
                checkpoint_document,
                proof,
                final,
                final_record,
            )
        except (OfflineSliceError, OfflineSliceInterrupted):
            raise
        except BaseException as exc:
            raise OfflineSliceError("Offline slice could not complete") from exc

    @staticmethod
    def _document(
        documents: dict[StageName, PipelineDocument],
        stage: StageName,
        expected: type[_DocumentT],
    ) -> _DocumentT:
        value = documents.get(stage)
        if type(value) is not expected:
            raise OfflineSliceError(f"Typed document is missing: {stage.value}")
        return value

    @staticmethod
    def _validate_request(request: OfflineSliceRequest) -> None:
        if type(request) is not OfflineSliceRequest:
            raise OfflineSliceError("Offline request must be OfflineSliceRequest")
        if type(request.job_id) is not JobId:
            raise OfflineSliceError("Offline job ID must be JobId")
        if not isinstance(request.source, Path) or not request.source.is_file():
            raise OfflineSliceError("Offline source must be an existing Path")
        if type(request.verified_input) is not VerifiedInputArchive:
            raise OfflineSliceError("Offline request requires verified input evidence")
        if request.verified_input.source.digest != request.verified_input.archive.digest:
            raise OfflineSliceError("Verified input identity is inconsistent")
        if (
            type(request.config_fingerprints) is not tuple
            or len(request.config_fingerprints) != len(STAGE_ORDER)
            or any(
                type(item) is not StageConfigFingerprint
                for item in request.config_fingerprints
            )
        ):
            raise OfflineSliceError("Offline configuration snapshot is incomplete")
        for path in (request.workspace_root, request.snapshot_dir):
            if not isinstance(path, Path) or not path.is_absolute() or not path.is_dir():
                raise OfflineSliceError(
                    "Offline workspace paths must be existing absolute directories"
                )
        if type(request.output_has_audio) is not bool:
            raise OfflineSliceError("Output audio policy must be boolean")
        if (
            type(request.verification_observed_at) is not int
            or request.verification_observed_at < 0
        ):
            raise OfflineSliceError("Checkpoint observation must be non-negative")
        for value in (
            request.at,
            request.proof_checkpoint_id,
            request.final_checkpoint_id,
        ):
            if (
                type(value) is not str
                or not value
                or value != value.strip()
                or len(value) > 60
            ):
                raise OfflineSliceError("Offline deterministic identifiers are invalid")
        if request.proof_checkpoint_id == request.final_checkpoint_id:
            raise OfflineSliceError("Proof and final checkpoints must be distinct")

    def _ensure_units(self, request: OfflineSliceRequest) -> None:
        for stage, key in zip(STAGE_ORDER, _UNIT_KEYS, strict=True):
            try:
                unit = self.state.get_work_unit(request.job_id, key)
            except RuntimeError as exc:
                if "does not exist" not in str(exc):
                    raise
                self.state.put_work_unit(
                    request.job_id,
                    WorkUnit(key, stage),
                    request.at,
                )
            else:
                if unit.stage is not stage:
                    raise OfflineSliceError("Stored work-unit graph is inconsistent")

    def _hit(self, stage: StageName, point: InterruptionPoint) -> None:
        if self.interruption is not None:
            self.interruption(stage, point)

    def _effective_checkpoint_id(
        self,
        request: OfflineSliceRequest,
        base: str,
        stages: tuple[StageName, ...],
    ) -> str:
        attempts = ",".join(
            f"{stage.value}:{self.state.get_work_unit(request.job_id, stage.value.lower()).attempts}"
            for stage in stages
        )
        payload = f"{base}|{request.job_id.value}|{attempts}".encode("utf-8")
        return f"{base}-{hashlib.sha256(payload).hexdigest()[:20]}"

    def _checkpoint_record(
        self,
        job_id: JobId,
        checkpoint_id: str,
    ) -> CheckpointRecord:
        records = tuple(
            item
            for item in self.state.completed_checkpoints(job_id)
            if item.checkpoint_id == checkpoint_id
        )
        if len(records) != 1:
            raise OfflineSliceError("Checkpoint completion evidence is ambiguous")
        return records[0]

    def _verify_checkpoint_record(
        self,
        record: CheckpointRecord,
        observed_at: int,
    ) -> None:
        def verify_entry(entry: ManifestEntry) -> None:
            evidence = self.checkpoints.object_store.verify(
                entry.key,
                entry.digest,
                observed_at,
                _VERIFY_METHOD,
            )
            if (
                type(evidence) is not RemoteObjectEvidence
                or evidence.entry != entry
                or evidence.observed_at != observed_at
                or evidence.method != _VERIFY_METHOD
            ):
                raise OfflineSliceError(
                    "Checkpoint remote verification evidence is invalid"
                )

        verify_entry(record.manifest)
        raw = self.checkpoints.object_store.read_bytes(
            record.manifest.key,
            _MAX_DOCUMENT_BYTES,
        )
        if self._digest(raw) != record.manifest.digest:
            raise OfflineSliceError("Checkpoint manifest digest is invalid")
        try:
            manifest = parse_manifest_bytes(raw)
        except DomainInvariantError as exc:
            raise OfflineSliceError("Checkpoint manifest is invalid") from exc
        if (
            manifest.job_id != record.job_id
            or manifest.checkpoint_id != record.checkpoint_id
            or manifest.state_snapshot != record.state_snapshot
        ):
            raise OfflineSliceError("Checkpoint manifest identity is invalid")

        entries = (
            record.state_snapshot,
            manifest.input_archive,
            manifest.state_snapshot,
            *manifest.artifacts,
        )
        seen: set[str] = set()
        for entry in entries:
            key = str(entry.key)
            if key in seen:
                continue
            seen.add(key)
            verify_entry(entry)

    def _checkpoint_id_for_publication(
        self,
        job_id: JobId,
        base: str,
        observed_at: int,
    ) -> str:
        pattern = re.compile(rf"{re.escape(base)}(?:-repair-([1-9][0-9]*))?")
        candidates: list[tuple[int, CheckpointRecord]] = []
        for record in self.state.completed_checkpoints(job_id):
            match = pattern.fullmatch(record.checkpoint_id)
            if match is None:
                continue
            generation = 0 if match.group(1) is None else int(match.group(1))
            candidates.append((generation, record))
        if not candidates:
            return base
        candidates.sort(key=lambda item: item[0])
        if len({generation for generation, _ in candidates}) != len(candidates):
            raise OfflineSliceError("Checkpoint repair evidence is ambiguous")
        generation, newest = candidates[-1]
        try:
            self._verify_checkpoint_record(newest, observed_at)
        except (BackupStoreError, OfflineSliceError):
            return f"{base}-repair-{generation + 1}"
        return newest.checkpoint_id

    @staticmethod
    def _discard_prepared(prepared: PreparedStage | None) -> None:
        if type(prepared) is PreparedRender:
            prepared.temporary_path.unlink(missing_ok=True)

    @staticmethod
    def _digest(raw: bytes) -> FileDigest:
        return FileDigest(len(raw), hashlib.sha256(raw).hexdigest())

    @staticmethod
    def _render_request(plan: RenderPlanDocument) -> RenderRequest:
        return RenderRequest(
            plan.schema_version,
            plan.job_id,
            plan.media_digest,
            plan.frame_count,
            plan.width,
            plan.height,
            plan.dependency_path,
            plan.dependency_digest,
            plan.cues,
            plan.blur_regions,
            plan.tts_audio_path,
            plan.tts_audio_digest,
            plan.parts,
            plan.output_has_audio,
        )

    @staticmethod
    def _dependencies(index: int) -> tuple[str, ...]:
        return () if index == 0 else (_NAMES[index - 1],)

    def _stage_artifacts(
        self,
        stage: StageName,
        index: int,
        document: PipelineDocument,
        primary: ManifestEntry,
    ) -> tuple[Artifact, ...]:
        dependencies = self._dependencies(index)
        artifacts = [
            Artifact(
                _NAMES[index],
                _PATHS[index],
                primary.digest.size_bytes,
                primary.digest.sha256,
                stage,
                dependencies,
            )
        ]
        side: tuple[str, PurePosixPath, FileDigest] | None = None
        if type(document) is TtsDocument:
            if document.audio_path != _TTS_AUDIO_PATH:
                raise OfflineSliceError("TTS side path is not canonical")
            side = (_SIDE_NAMES[stage], document.audio_path, document.audio_digest)
        elif type(document) is RenderPlanDocument:
            if document.rendered_path != _RENDERED_PATH:
                raise OfflineSliceError("Rendered side path is not canonical")
            side = (
                _SIDE_NAMES[stage],
                document.rendered_path,
                document.rendered_digest,
            )
        elif type(document) is PublicationDocument:
            if document.part_paths != (_PUBLISHED_PATH,) or len(document.part_digests) != 1:
                raise OfflineSliceError("Published side path is not canonical")
            side = (
                _SIDE_NAMES[stage],
                document.part_paths[0],
                document.part_digests[0],
            )
        if side is not None:
            name, path, digest = side
            artifacts.append(
                Artifact(
                    name,
                    path,
                    digest.size_bytes,
                    digest.sha256,
                    stage,
                    dependencies,
                )
            )
        return tuple(artifacts)

    def _classify_stage_artifacts(
        self,
        stage: StageName,
        index: int,
        artifacts: tuple[Artifact, ...],
    ) -> tuple[Artifact, Artifact | None] | None:
        dependencies = self._dependencies(index)
        expected = {(_NAMES[index], _PATHS[index])}
        side_name = _SIDE_NAMES.get(stage)
        side_path = {
            StageName.TTS: _TTS_AUDIO_PATH,
            StageName.RENDER: _RENDERED_PATH,
            StageName.PUBLISH: _PUBLISHED_PATH,
        }.get(stage)
        if side_name is not None and side_path is not None:
            expected.add((side_name, side_path))
        actual = {(item.name, item.relative_path) for item in artifacts}
        if len(actual) != len(artifacts) or any(
            item.owner is not stage or item.dependencies != dependencies
            for item in artifacts
        ):
            raise OfflineSliceError("Canonical artifact ownership is ambiguous")
        if not actual.issubset(expected):
            raise OfflineSliceError(
                "Canonical artifact graph is ambiguous: unknown extras"
            )
        if actual != expected:
            return None
        by_identity = {
            (item.name, item.relative_path): item
            for item in artifacts
        }
        primary = by_identity[(_NAMES[index], _PATHS[index])]
        side = (
            None
            if side_name is None or side_path is None
            else by_identity[(side_name, side_path)]
        )
        return primary, side

    def _parse_document(
        self,
        stage: StageName,
        raw: bytes,
        upstream: PipelineDocument | None,
    ) -> PipelineDocument:
        if stage is StageName.INGEST:
            return parse_media_document_bytes(raw)
        if stage is StageName.OCR and type(upstream) is MediaDocument:
            return parse_ocr_document_bytes(raw, upstream)
        if stage is StageName.TRACK and type(upstream) is OcrDocument:
            return parse_track_document_bytes(raw, upstream)
        if stage is StageName.TRANSLATE and type(upstream) is TrackDocument:
            return parse_translation_document_bytes(raw, upstream)
        if stage is StageName.TTS and type(upstream) is TranslationDocument:
            return parse_tts_document_bytes(raw, upstream)
        if stage is StageName.RENDER and type(upstream) is TtsDocument:
            return parse_render_plan_document_bytes(raw, upstream)
        if stage is StageName.PUBLISH and type(upstream) is RenderPlanDocument:
            return parse_publication_document_bytes(raw, upstream)
        if stage is StageName.BACKUP and type(upstream) is PublicationDocument:
            return parse_checkpoint_document_bytes(raw, upstream)
        raise OfflineSliceError("Canonical document dependency type is invalid")

    def _resume_workspace(self, request: OfflineSliceRequest) -> ResumeState:
        artifacts = self.state.valid_artifacts(request.job_id)
        by_owner: dict[StageName, tuple[Artifact, ...]] = {
            stage: tuple(item for item in artifacts if item.owner is stage)
            for stage in STAGE_ORDER
        }
        writer = self.artifact_writers(request.workspace_root)
        documents: dict[StageName, PipelineDocument] = {}
        damaged: StageName | None = None
        upstream: PipelineDocument | None = None
        primary_by_stage: dict[StageName, Artifact] = {}
        for index, stage in enumerate(STAGE_ORDER):
            unit = self.state.get_work_unit(request.job_id, _UNIT_KEYS[index])
            values = by_owner[stage]
            if unit.status is not WorkStatus.SUCCEEDED:
                if values:
                    raise OfflineSliceError("Non-succeeded work owns a valid artifact")
                continue
            classified = self._classify_stage_artifacts(stage, index, values)
            if classified is None:
                damaged = stage
                break
            primary, side = classified
            primary_by_stage[stage] = primary
            try:
                expected = FileDigest(primary.size_bytes, primary.sha256)
                raw = writer.read_verified_bytes(
                    primary.relative_path,
                    expected,
                    _MAX_DOCUMENT_BYTES,
                )
                document = self._parse_document(stage, raw, upstream)
                self._verify_side(
                    stage,
                    document,
                    side,
                    documents,
                    writer,
                    request.workspace_root,
                    request.verification_observed_at,
                )
            except (DomainInvariantError, OSError, RuntimeError):
                damaged = stage
                break
            documents[stage] = document
            upstream = document

        if damaged is None:
            for stage, key in zip(STAGE_ORDER, _UNIT_KEYS, strict=True):
                if self.state.get_work_unit(request.job_id, key).status is WorkStatus.INVALID:
                    damaged = stage
                    break
        if damaged is None:
            return ResumeState(request.workspace_root, documents, None)

        invalidation = plan_invalidation(
            request.config_fingerprints,
            request.config_fingerprints,
            changed_artifact_owners=(damaged,),
        )
        self.state.apply_invalidation(request.job_id, invalidation, request.at)
        proof_repair_token = None
        if damaged is StageName.BACKUP:
            primary = primary_by_stage.get(StageName.BACKUP)
            candidates = by_owner[StageName.BACKUP]
            if primary is not None:
                proof_repair_token = primary.sha256[:20]
            elif candidates:
                proof_repair_token = candidates[0].sha256[:20]

        fresh = request.fresh_workspace_root
        if (
            fresh is None
            or not isinstance(fresh, Path)
            or not fresh.is_absolute()
            or not fresh.is_dir()
            or fresh == request.workspace_root
            or any(fresh.iterdir())
        ):
            raise FreshWorkspaceRequired(
                f"Damaged {damaged.value} output requires an empty fresh workspace"
            )
        fresh_writer = self.artifact_writers(fresh)
        damaged_index = STAGE_ORDER.index(damaged)
        for index in range(damaged_index):
            for artifact in by_owner[STAGE_ORDER[index]]:
                expected = FileDigest(artifact.size_bytes, artifact.sha256)
                source = request.workspace_root.joinpath(*artifact.relative_path.parts)
                if self.files.digest(source) != expected:
                    raise FreshWorkspaceRequired("Verified upstream artifact changed")
                copied = fresh_writer.write_file(artifact.relative_path, source)
                if copied.digest != expected:
                    raise FreshWorkspaceRequired("Upstream artifact copy changed")
        return ResumeState(
            fresh,
            {
                stage: document
                for stage, document in documents.items()
                if STAGE_ORDER.index(stage) < damaged_index
            },
            proof_repair_token,
        )

    def _verify_side(
        self,
        stage: StageName,
        document: PipelineDocument,
        side: Artifact | None,
        documents: dict[StageName, PipelineDocument],
        writer: ArtifactWriter,
        workspace: Path,
        observed_at: int,
    ) -> None:
        expected: tuple[PurePosixPath, FileDigest] | None = None
        if type(document) is TtsDocument:
            expected = (document.audio_path, document.audio_digest)
        elif type(document) is RenderPlanDocument:
            expected = (document.rendered_path, document.rendered_digest)
        elif type(document) is PublicationDocument:
            if len(document.part_paths) != 1 or len(document.part_digests) != 1:
                raise OfflineSliceError("Offline publication side evidence is invalid")
            expected = (document.part_paths[0], document.part_digests[0])
        if expected is not None:
            path, digest = expected
            if side is None or (
                side.relative_path != path
                or FileDigest(side.size_bytes, side.sha256) != digest
            ):
                raise OfflineSliceError("Side artifact row does not match its document")
            writer.verify(path, digest)
        elif side is not None:
            raise OfflineSliceError("Unexpected side artifact row")

        if type(document) is RenderPlanDocument:
            self.media.validate_render(
                workspace.joinpath(*document.rendered_path.parts),
                self._render_request(document),
            )
        elif type(document) is PublicationDocument:
            plan = self._document(documents, StageName.RENDER, RenderPlanDocument)
            self.media.validate_render(
                workspace.joinpath(*document.part_paths[0].parts),
                self._render_request(plan),
            )
        elif type(document) is CheckpointDocument:
            records = tuple(
                item
                for item in self.state.completed_checkpoints(document.job_id)
                if item.checkpoint_id == document.checkpoint_id
            )
            if len(records) != 1 or (
                records[0].manifest.key != document.manifest_path
                or records[0].manifest.digest != document.manifest_digest
                or records[0].state_snapshot.key != document.state_snapshot_path
                or records[0].state_snapshot.digest != document.state_snapshot_digest
            ):
                raise OfflineSliceError("Proof checkpoint evidence is invalid")
            self._verify_checkpoint_record(records[0], observed_at)

    def _prepare(
        self,
        stage: StageName,
        request: OfflineSliceRequest,
        workspace: Path,
        documents: dict[StageName, PipelineDocument],
        writer: ArtifactWriter,
        proof_repair_token: str | None,
    ) -> PreparedStage:
        if stage is StageName.INGEST:
            return replace(
                self.media.probe(request.source),
                job_id=request.job_id,
                source_path=request.verified_input.archive.key,
                source_digest=request.verified_input.archive.digest,
            )
        if stage is StageName.OCR:
            return self.ocr.detect(
                self._document(documents, StageName.INGEST, MediaDocument)
            )
        if stage is StageName.TRACK:
            ocr = self._document(documents, StageName.OCR, OcrDocument)
            configured_regions = tuple(
                BlurRegion(region.kind, FrameInterval(0, ocr.frame_count), region.box)
                for region in request.blur_regions
            )
            return TrackDocument(
                ocr.schema_version,
                ocr.job_id,
                ocr.media_digest,
                ocr.frame_count,
                ocr.width,
                ocr.height,
                OCR_ARTIFACT_PATH,
                self._digest(canonical_document_bytes(ocr)),
                ocr.cues,
                configured_regions + tuple(
                    BlurRegion(RegionKind.DYNAMIC, cue.interval, cue.box)
                    for cue in ocr.cues
                ),
            )
        if stage is StageName.TRANSLATE:
            return self.translation.translate(
                self._document(documents, StageName.TRACK, TrackDocument)
            )
        if stage is StageName.TTS:
            return self.tts.synthesize(
                self._document(documents, StageName.TRANSLATE, TranslationDocument)
            )
        if stage is StageName.RENDER:
            tts = self._document(documents, StageName.TTS, TtsDocument)
            track = self._document(documents, StageName.TRACK, TrackDocument)
            render_request = RenderRequest(
                tts.schema_version,
                tts.job_id,
                tts.media_digest,
                tts.frame_count,
                tts.width,
                tts.height,
                TTS_ARTIFACT_PATH,
                self._digest(canonical_document_bytes(tts)),
                tts.cues,
                track.blur_regions,
                tts.audio_path,
                tts.audio_digest,
                (_PART,),
                request.output_has_audio,
            )
            temporary = tempfile.NamedTemporaryFile(
                prefix="offline-render-",
                suffix=".mp4",
                dir=request.snapshot_dir,
                delete=False,
            )
            temporary_path = Path(temporary.name)
            temporary.close()
            temporary_path.unlink()
            self.media.render(
                request.source,
                workspace.joinpath(*tts.audio_path.parts),
                render_request,
                temporary_path,
            )
            return PreparedRender(render_request, temporary_path)
        if stage is StageName.PUBLISH:
            plan = self._document(documents, StageName.RENDER, RenderPlanDocument)
            source = workspace.joinpath(*plan.rendered_path.parts)
            if self.files.digest(source) != plan.rendered_digest:
                raise OfflineSliceError("Rendered side asset changed before publication")
            self.media.validate_render(source, self._render_request(plan))
            return PreparedPublish(plan, source)
        if stage is StageName.BACKUP:
            publication = self._document(
                documents,
                StageName.PUBLISH,
                PublicationDocument,
            )
            existing_path = workspace.joinpath(*_PATHS[-1].parts)
            if existing_path.is_file():
                expected = self.files.digest(existing_path)
                raw = writer.read_verified_bytes(
                    _PATHS[-1],
                    expected,
                    _MAX_DOCUMENT_BYTES,
                )
                existing = parse_checkpoint_document_bytes(raw, publication)
                record = self._checkpoint_record(
                    request.job_id,
                    existing.checkpoint_id,
                )
                if (
                    record.manifest.key != existing.manifest_path
                    or record.manifest.digest != existing.manifest_digest
                    or record.state_snapshot.key != existing.state_snapshot_path
                    or record.state_snapshot.digest != existing.state_snapshot_digest
                ):
                    raise OfflineSliceError(
                        "Uncommitted BACKUP document has invalid proof evidence"
                    )
                self._verify_checkpoint_record(
                    record,
                    request.verification_observed_at,
                )
                return PreparedBackup(publication, None, record)
            proof_base = self._effective_checkpoint_id(
                request,
                request.proof_checkpoint_id,
                STAGE_ORDER[:-1],
            )
            if proof_repair_token is not None:
                proof_base = f"{proof_base}-repair-{proof_repair_token}"
            proof_id = self._checkpoint_id_for_publication(
                request.job_id,
                proof_base,
                request.verification_observed_at,
            )
            proof = self.checkpoints.publish(
                request.job_id,
                proof_id,
                workspace,
                request.snapshot_dir,
                request.at,
                verification_observed_at=request.verification_observed_at,
                verification_method=_VERIFY_METHOD,
            )
            record = self._checkpoint_record(request.job_id, proof_id)
            self._verify_checkpoint_record(
                record,
                request.verification_observed_at,
            )
            return PreparedBackup(publication, proof, record)
        raise OfflineSliceError("Unsupported offline stage")

    def _publish_prepared(
        self,
        stage: StageName,
        prepared: PreparedStage,
        writer: ArtifactWriter,
        publisher: PartPublisher,
    ) -> PipelineDocument:
        if stage is StageName.INGEST and type(prepared) is MediaDocument:
            return prepared
        if stage is StageName.OCR and type(prepared) is OcrDocument:
            return prepared
        if stage is StageName.TRACK and type(prepared) is TrackDocument:
            return prepared
        if stage is StageName.TRANSLATE and type(prepared) is TranslationDocument:
            return prepared
        if stage is StageName.TTS and type(prepared) is TtsSynthesis:
            entry = writer.write_bytes(
                prepared.document.audio_path,
                prepared.audio_bytes,
            )
            if entry.digest != prepared.document.audio_digest:
                raise OfflineSliceError("TTS side publication changed")
            writer.verify(prepared.document.audio_path, entry.digest)
            return prepared.document
        if stage is StageName.RENDER and type(prepared) is PreparedRender:
            try:
                rendered_entry = writer.write_file(
                    _RENDERED_PATH,
                    prepared.temporary_path,
                )
            finally:
                prepared.temporary_path.unlink(missing_ok=True)
            writer.verify(_RENDERED_PATH, rendered_entry.digest)
            request = prepared.request
            return RenderPlanDocument(
                request.schema_version,
                request.job_id,
                request.media_digest,
                request.frame_count,
                request.width,
                request.height,
                request.dependency_path,
                request.dependency_digest,
                request.cues,
                request.blur_regions,
                request.tts_audio_path,
                request.tts_audio_digest,
                request.parts,
                request.output_has_audio,
                _RENDERED_PATH,
                rendered_entry.digest,
            )
        if stage is StageName.PUBLISH and type(prepared) is PreparedPublish:
            part_entry = publisher.publish(prepared.source, _PART)
            plan = prepared.plan
            return PublicationDocument(
                plan.schema_version,
                plan.job_id,
                plan.media_digest,
                plan.frame_count,
                plan.width,
                plan.height,
                RENDER_PLAN_ARTIFACT_PATH,
                self._digest(canonical_document_bytes(plan)),
                plan.parts,
                (part_entry.key,),
                (part_entry.digest,),
            )
        if stage is StageName.BACKUP and type(prepared) is PreparedBackup:
            publication = prepared.publication
            record = prepared.record
            return CheckpointDocument(
                publication.schema_version,
                publication.job_id,
                publication.media_digest,
                publication.frame_count,
                publication.width,
                publication.height,
                PUBLICATION_ARTIFACT_PATH,
                self._digest(canonical_document_bytes(publication)),
                record.checkpoint_id,
                record.manifest.key,
                record.manifest.digest,
                record.state_snapshot.key,
                record.state_snapshot.digest,
            )
        raise OfflineSliceError("Prepared stage value does not match its stage")
