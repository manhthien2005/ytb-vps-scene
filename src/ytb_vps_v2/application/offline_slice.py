from __future__ import annotations

import hashlib
import re
import tempfile
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Callable

from ytb_vps_v2.adapters.filesystem.artifacts import LocalArtifactWriter
from ytb_vps_v2.adapters.filesystem.integrity import digest_file
from ytb_vps_v2.adapters.filesystem.publish import LocalPartPublisher
from ytb_vps_v2.application.checkpoints import CheckpointPublisher
from ytb_vps_v2.application.invalidation import plan_invalidation
from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    CheckpointRecord,
    FileDigest,
    VerifiedInputArchive,
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
from ytb_vps_v2.ports.pipeline import OcrProvider, TranslationProvider, TtsProvider
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
_RENDERED_PATH = PurePosixPath("artifacts/render/rendered.mp4")
_PART = Part(1, 1, FrameInterval(0, 900), (0,))
_VERIFY_METHOD = "sha256-readback"


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


class OfflineSliceRunner:
    def __init__(
        self,
        state: StateRepository,
        checkpoints: CheckpointPublisher,
        media: object,
        ocr: OcrProvider,
        translation: TranslationProvider,
        tts: TtsProvider,
        interruption: InterruptionHook | None = None,
    ) -> None:
        self.state = state
        self.checkpoints = checkpoints
        self.media = media
        self.ocr = ocr
        self.translation = translation
        self.tts = tts
        self.interruption = interruption

    def run(self, request: OfflineSliceRequest) -> OfflineSliceResult:
        self._validate_request(request)
        self._proof_repair_token: str | None = None
        try:
            if digest_file(request.source) != request.verified_input.archive.digest:
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
            workspace, documents = self._resume_workspace(request)
            writer = LocalArtifactWriter(workspace)
            publisher = LocalPartPublisher(workspace)

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
                prepared: object | None = None
                try:
                    prepared = self._prepare(
                        stage,
                        request,
                        workspace,
                        documents,
                    )
                    self._hit(stage, InterruptionPoint.AFTER_PROVIDER)
                    self._hit(stage, InterruptionPoint.BEFORE_FILESYSTEM_PUBLICATION)
                    document = self._publish_prepared(
                        stage,
                        prepared,
                        writer,
                        publisher,
                        workspace,
                    )
                    raw = canonical_document_bytes(document)
                    entry = writer.write_bytes(_PATHS[index], raw)
                    self._hit(stage, InterruptionPoint.AFTER_FILESYSTEM_PUBLICATION)
                    artifact = Artifact(
                        _NAMES[index],
                        _PATHS[index],
                        entry.digest.size_bytes,
                        entry.digest.sha256,
                        stage,
                        () if index == 0 else (_NAMES[index - 1],),
                    )
                    self.state.commit_artifact(
                        request.job_id,
                        unit.key,
                        artifact,
                        request.at,
                    )
                    documents[stage] = document
                    self._hit(stage, InterruptionPoint.AFTER_SQLITE_COMMIT)
                except OfflineSliceInterrupted:
                    self._discard_prepared(stage, prepared)
                    raise
                except BaseException as exc:
                    self._discard_prepared(stage, prepared)
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

            checkpoint_document = documents[StageName.BACKUP]
            proof_id = checkpoint_document.checkpoint_id  # type: ignore[attr-defined]
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
            )
            final_record = self._checkpoint_record(request.job_id, final_id)
            self._verify_checkpoint_record(
                final_record,
                request.verification_observed_at,
            )
            artifacts_by_owner = {
                artifact.owner: artifact
                for artifact in self.state.valid_artifacts(request.job_id)
            }
            return OfflineSliceResult(
                request.job_id,
                workspace,
                tuple(
                    self.state.get_work_unit(request.job_id, key)
                    for key in _UNIT_KEYS
                ),
                tuple(artifacts_by_owner[stage] for stage in STAGE_ORDER),
                documents[StageName.PUBLISH],  # type: ignore[arg-type]
                documents[StageName.BACKUP],  # type: ignore[arg-type]
                proof,
                final,
                final_record,
            )
        except (OfflineSliceError, OfflineSliceInterrupted):
            raise
        except BaseException as exc:
            raise OfflineSliceError("Offline slice could not complete") from exc

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
            or any(type(item) is not StageConfigFingerprint for item in request.config_fingerprints)
        ):
            raise OfflineSliceError("Offline configuration snapshot is incomplete")
        for path in (request.workspace_root, request.snapshot_dir):
            if not isinstance(path, Path) or not path.is_absolute() or not path.is_dir():
                raise OfflineSliceError("Offline workspace paths must be existing absolute directories")
        if type(request.output_has_audio) is not bool:
            raise OfflineSliceError("Output audio policy must be boolean")
        if (
            type(request.verification_observed_at) is not int
            or request.verification_observed_at < 0
        ):
            raise OfflineSliceError("Checkpoint observation must be non-negative")
        for value in (request.at, request.proof_checkpoint_id, request.final_checkpoint_id):
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
        for entry in (record.manifest, record.state_snapshot):
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
    def _discard_prepared(stage: StageName, prepared: object | None) -> None:
        if stage is StageName.RENDER and isinstance(prepared, tuple) and len(prepared) == 2:
            candidate = prepared[1]
            if isinstance(candidate, Path):
                candidate.unlink(missing_ok=True)

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

    def _resume_workspace(
        self,
        request: OfflineSliceRequest,
    ) -> tuple[Path, dict[StageName, object]]:
        artifacts = self.state.valid_artifacts(request.job_id)
        by_owner: dict[StageName, list[Artifact]] = {stage: [] for stage in STAGE_ORDER}
        for artifact in artifacts:
            by_owner[artifact.owner].append(artifact)
        for index, stage in enumerate(STAGE_ORDER):
            values = by_owner[stage]
            if len(values) > 1:
                raise OfflineSliceError("Canonical artifact ownership is ambiguous")
            if values:
                artifact = values[0]
                expected_dependencies = () if index == 0 else (_NAMES[index - 1],)
                if (
                    artifact.name != _NAMES[index]
                    or artifact.relative_path != _PATHS[index]
                    or artifact.dependencies != expected_dependencies
                ):
                    raise OfflineSliceError("Canonical artifact graph is inconsistent")

        writer = LocalArtifactWriter(request.workspace_root)
        documents: dict[StageName, object] = {}
        damaged: StageName | None = None
        upstream: object | None = None
        parsers = (
            parse_media_document_bytes,
            parse_ocr_document_bytes,
            parse_track_document_bytes,
            parse_translation_document_bytes,
            parse_tts_document_bytes,
            parse_render_plan_document_bytes,
            parse_publication_document_bytes,
            parse_checkpoint_document_bytes,
        )
        for index, stage in enumerate(STAGE_ORDER):
            unit = self.state.get_work_unit(request.job_id, _UNIT_KEYS[index])
            values = by_owner[stage]
            if unit.status is not WorkStatus.SUCCEEDED:
                if values:
                    raise OfflineSliceError("Non-succeeded work owns a valid artifact")
                upstream = None if index == 0 else upstream
                continue
            if len(values) != 1:
                damaged = stage
                break
            artifact = values[0]
            try:
                expected = FileDigest(artifact.size_bytes, artifact.sha256)
                writer.verify(artifact.relative_path, expected)
                raw = request.workspace_root.joinpath(*artifact.relative_path.parts).read_bytes()
                document = parsers[index](raw) if index == 0 else parsers[index](raw, upstream)
                self._verify_side(
                    stage,
                    document,
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
                if (
                    self.state.get_work_unit(request.job_id, key).status
                    is WorkStatus.INVALID
                ):
                    damaged = stage
                    break
        if damaged is None:
            return request.workspace_root, documents
        invalidation = plan_invalidation(
            request.config_fingerprints,
            request.config_fingerprints,
            changed_artifact_owners=(damaged,),
        )
        self.state.apply_invalidation(request.job_id, invalidation, request.at)
        if damaged is StageName.BACKUP:
            previous = request.workspace_root.joinpath(*_PATHS[-1].parts)
            if previous.is_file():
                self._proof_repair_token = hashlib.sha256(
                    previous.read_bytes()
                ).hexdigest()[:20]
            elif by_owner[StageName.BACKUP]:
                self._proof_repair_token = by_owner[StageName.BACKUP][0].sha256[:20]
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
        fresh_writer = LocalArtifactWriter(fresh)
        damaged_index = STAGE_ORDER.index(damaged)
        for index in range(damaged_index):
            artifact = by_owner[STAGE_ORDER[index]][0]
            source = request.workspace_root.joinpath(*artifact.relative_path.parts)
            fresh_writer.write_file(artifact.relative_path, source)
            self._copy_sides(documents[STAGE_ORDER[index]], request.workspace_root, fresh_writer)
        return fresh, {
            stage: document
            for stage, document in documents.items()
            if STAGE_ORDER.index(stage) < damaged_index
        }

    def _copy_sides(
        self,
        document: object,
        old_root: Path,
        writer: LocalArtifactWriter,
    ) -> None:
        references: tuple[tuple[PurePosixPath, FileDigest], ...] = ()
        if type(document) is TtsDocument:
            references = ((document.audio_path, document.audio_digest),)
        elif type(document) is RenderPlanDocument:
            references = ((document.rendered_path, document.rendered_digest),)
        elif type(document) is PublicationDocument:
            references = tuple(zip(document.part_paths, document.part_digests, strict=True))
        for path, digest in references:
            source = old_root.joinpath(*path.parts)
            if digest_file(source) != digest:
                raise FreshWorkspaceRequired("Verified upstream side asset changed")
            writer.write_file(path, source)

    def _verify_side(
        self,
        stage: StageName,
        document: object,
        documents: dict[StageName, object],
        writer: LocalArtifactWriter,
        workspace: Path,
        observed_at: int,
    ) -> None:
        if stage is StageName.TTS:
            value = document
            writer.verify(value.audio_path, value.audio_digest)  # type: ignore[attr-defined]
        elif stage is StageName.RENDER:
            value = document
            writer.verify(value.rendered_path, value.rendered_digest)  # type: ignore[attr-defined]
            self.media.validate_render(
                workspace.joinpath(*value.rendered_path.parts),  # type: ignore[attr-defined]
                self._render_request(value),  # type: ignore[arg-type]
            )
        elif stage is StageName.PUBLISH:
            value = document
            plan = documents[StageName.RENDER]
            for path, digest in zip(value.part_paths, value.part_digests, strict=True):  # type: ignore[attr-defined]
                writer.verify(path, digest)
                self.media.validate_render(
                    workspace.joinpath(*path.parts),
                    self._render_request(plan),  # type: ignore[arg-type]
                )
        elif stage is StageName.BACKUP:
            value = document
            records = tuple(
                item
                for item in self.state.completed_checkpoints(value.job_id)  # type: ignore[attr-defined]
                if item.checkpoint_id == value.checkpoint_id  # type: ignore[attr-defined]
            )
            if len(records) != 1 or (
                records[0].manifest.key != value.manifest_path  # type: ignore[attr-defined]
                or records[0].manifest.digest != value.manifest_digest  # type: ignore[attr-defined]
                or records[0].state_snapshot.key != value.state_snapshot_path  # type: ignore[attr-defined]
                or records[0].state_snapshot.digest != value.state_snapshot_digest  # type: ignore[attr-defined]
            ):
                raise OfflineSliceError("Proof checkpoint evidence is invalid")
            self._verify_checkpoint_record(records[0], observed_at)

    def _prepare(
        self,
        stage: StageName,
        request: OfflineSliceRequest,
        workspace: Path,
        documents: dict[StageName, object],
    ) -> object:
        if stage is StageName.INGEST:
            probed = self.media.probe(request.source)
            return replace(
                probed,
                job_id=request.job_id,
                source_path=request.verified_input.archive.key,
                source_digest=request.verified_input.archive.digest,
            )
        if stage is StageName.OCR:
            return self.ocr.detect(documents[StageName.INGEST])
        if stage is StageName.TRACK:
            ocr = documents[StageName.OCR]
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
                tuple(
                    BlurRegion(RegionKind.DYNAMIC, cue.interval, cue.box)
                    for cue in ocr.cues
                ),
            )
        if stage is StageName.TRANSLATE:
            return self.translation.translate(documents[StageName.TRACK])
        if stage is StageName.TTS:
            return self.tts.synthesize(documents[StageName.TRANSLATE])
        if stage is StageName.RENDER:
            tts = documents[StageName.TTS]
            track = documents[StageName.TRACK]
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
            return render_request, temporary_path
        if stage is StageName.PUBLISH:
            plan = documents[StageName.RENDER]
            source = workspace.joinpath(*plan.rendered_path.parts)
            if digest_file(source) != plan.rendered_digest:
                raise OfflineSliceError("Rendered side asset changed before publication")
            self.media.validate_render(source, self._render_request(plan))
            return plan, source
        if stage is StageName.BACKUP:
            publication = documents[StageName.PUBLISH]
            existing_path = workspace.joinpath(*_PATHS[-1].parts)
            if existing_path.is_file():
                existing = parse_checkpoint_document_bytes(
                    existing_path.read_bytes(),
                    publication,  # type: ignore[arg-type]
                )
                records = tuple(
                    item
                    for item in self.state.completed_checkpoints(request.job_id)
                    if item.checkpoint_id == existing.checkpoint_id
                )
                if len(records) != 1 or (
                    records[0].manifest.key != existing.manifest_path
                    or records[0].manifest.digest != existing.manifest_digest
                    or records[0].state_snapshot.key != existing.state_snapshot_path
                    or records[0].state_snapshot.digest
                    != existing.state_snapshot_digest
                ):
                    raise OfflineSliceError(
                        "Uncommitted BACKUP document has invalid proof evidence"
                    )
                self._verify_checkpoint_record(
                    records[0],
                    request.verification_observed_at,
                )
                return publication, None, records[0]
            proof_base = self._effective_checkpoint_id(
                request,
                request.proof_checkpoint_id,
                STAGE_ORDER[:-1],
            )
            if self._proof_repair_token is not None:
                proof_base = f"{proof_base}-repair-{self._proof_repair_token}"
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
            )
            record = self._checkpoint_record(request.job_id, proof_id)
            self._verify_checkpoint_record(
                record,
                request.verification_observed_at,
            )
            return publication, proof, record
        raise OfflineSliceError("Unsupported offline stage")

    def _publish_prepared(
        self,
        stage: StageName,
        prepared: object,
        writer: LocalArtifactWriter,
        publisher: LocalPartPublisher,
        workspace: Path,
    ) -> object:
        if stage in {
            StageName.INGEST,
            StageName.OCR,
            StageName.TRACK,
            StageName.TRANSLATE,
        }:
            return prepared
        if stage is StageName.TTS:
            writer.write_bytes(prepared.document.audio_path, prepared.audio_bytes)  # type: ignore[attr-defined]
            writer.verify(prepared.document.audio_path, prepared.document.audio_digest)  # type: ignore[attr-defined]
            return prepared.document  # type: ignore[attr-defined]
        if stage is StageName.RENDER:
            request, temporary_path = prepared  # type: ignore[misc]
            try:
                rendered_entry = writer.write_file(_RENDERED_PATH, temporary_path)
            finally:
                temporary_path.unlink(missing_ok=True)
            writer.verify(_RENDERED_PATH, rendered_entry.digest)
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
        if stage is StageName.PUBLISH:
            plan, source = prepared  # type: ignore[misc]
            part_entry = publisher.publish(source, _PART)
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
        if stage is StageName.BACKUP:
            publication, _, record = prepared  # type: ignore[misc]
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
        raise OfflineSliceError("Unsupported offline publication stage")
