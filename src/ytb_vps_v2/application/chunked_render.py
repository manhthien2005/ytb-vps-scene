from __future__ import annotations

import tempfile
from collections.abc import Callable
from dataclasses import dataclass, replace
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import Protocol

from ytb_vps_v2.application.disk_guard import ensure_free_space
from ytb_vps_v2.application.render_chunks import (
    chunk_local_request,
    part_local_request,
)
from ytb_vps_v2.domain.backup import (
    CheckpointManifest,
    FileDigest,
)
from ytb_vps_v2.domain.fingerprints import Fingerprint
from ytb_vps_v2.domain.models import (
    Artifact,
    JobId,
    Part,
    RenderChunk,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.parts import MAX_PART_SECONDS
from ytb_vps_v2.domain.pipeline import (
    RENDER_CHUNK_PLAN_ARTIFACT_PATH,
    RenderChunkPlanDocument,
    RenderRequest,
    RenderedPart,
    canonical_document_bytes,
    parse_render_chunk_plan_document_bytes,
)
from ytb_vps_v2.domain.render_chunks import (
    part_file_name,
    plan_parts_for_chunks,
    plan_render_chunks,
    single_part_for_chunks,
)
from ytb_vps_v2.ports.pipeline import (
    ArtifactWriter,
    FileDigestVerifier,
    MediaPipeline,
)
from ytb_vps_v2.ports.state import StateRepository


_PLAN_UNIT = "render:plan"
_FINAL_UNIT = "render"
_PLAN_ARTIFACT_NAME = "render-chunk-plan"
_VERIFY_METHOD = "sha256-readback"
_MINIMUM_CHUNK_ESTIMATE = 16 * 1024 * 1024


class ChunkedRenderError(RuntimeError):
    """Raised when durable chunk preparation cannot safely complete."""


class ChunkInterruptionPoint(str, Enum):
    BEFORE_RENDER = "before_render"
    AFTER_RENDER = "after_render"
    AFTER_FILESYSTEM_PUBLICATION = "after_filesystem_publication"
    AFTER_SQLITE_COMMIT = "after_sqlite_commit"
    DURING_CHECKPOINT = "during_checkpoint"


ChunkInterruptionHook = Callable[[int, ChunkInterruptionPoint], None]
FreeSpaceGuard = Callable[[Path, int], None]


class ChunkCheckpointPublisher(Protocol):
    def latest_verified_v2(
        self,
        job_id: JobId,
        checkpoint_prefix: str,
        observed_at: int,
    ) -> CheckpointManifest | None: ...

    def publish(
        self,
        job_id: JobId,
        checkpoint_id: str,
        workspace_root: Path,
        snapshot_dir: Path,
        at: str,
        *,
        verification_observed_at: int,
        verification_method: str,
        reuse: CheckpointManifest | None = None,
    ) -> CheckpointManifest: ...

    def verify_manifest(
        self,
        manifest: CheckpointManifest,
        observed_at: int,
        method: str = _VERIFY_METHOD,
    ) -> CheckpointManifest: ...


@dataclass(frozen=True, slots=True)
class PreparedRender:
    request: RenderRequest
    rendered_parts: tuple[RenderedPart, ...]


def _chunk_unit_key(chunk: RenderChunk) -> str:
    return f"render:{chunk.index:06d}"


def _chunk_artifact_path(chunk: RenderChunk) -> PurePosixPath:
    return PurePosixPath(
        f"artifacts/render/chunks/chunk-{chunk.index:06d}.mp4"
    )


def _chunk_artifact_name(chunk: RenderChunk) -> str:
    return f"render-chunk-{chunk.index:06d}"


def _part_unit_key(part: Part) -> str:
    return f"render:part:{part.part_index:06d}"


def _part_artifact_path(part: Part) -> PurePosixPath:
    return PurePosixPath("artifacts/render/parts") / part_file_name(
        part.part_index,
        part.part_count,
    )


def _part_artifact_name(part: Part) -> str:
    return f"render-part-{part.part_index:06d}"


class ChunkedRenderCoordinator:
    def __init__(
        self,
        state: StateRepository,
        checkpoints: ChunkCheckpointPublisher,
        media: MediaPipeline,
        files: FileDigestVerifier,
        *,
        free_space: FreeSpaceGuard = ensure_free_space,
        interruption: ChunkInterruptionHook | None = None,
    ) -> None:
        self.state = state
        self.checkpoints = checkpoints
        self.media = media
        self.files = files
        self.free_space = free_space
        self.interruption = interruption

    def _hit(
        self,
        chunk: RenderChunk,
        point: ChunkInterruptionPoint,
    ) -> None:
        if self.interruption is not None:
            self.interruption(chunk.index, point)

    def _ensure_unit(
        self,
        job_id: JobId,
        expected: WorkUnit,
        at: str,
    ) -> WorkUnit:
        try:
            unit = self.state.get_work_unit(job_id, expected.key)
        except RuntimeError as exc:
            if "does not exist" not in str(exc):
                raise
            self.state.put_work_unit(job_id, expected, at)
            return expected
        if (
            unit.stage is not expected.stage
            or unit.dependencies != expected.dependencies
        ):
            raise ChunkedRenderError(
                f"Stored work unit conflicts with {expected.key}"
            )
        return unit

    @staticmethod
    def _temporary_path(snapshot_dir: Path, prefix: str) -> Path:
        handle = tempfile.NamedTemporaryFile(
            prefix=prefix,
            suffix=".mp4",
            dir=snapshot_dir,
            delete=False,
        )
        path = Path(handle.name)
        handle.close()
        path.unlink()
        return path

    def _plan_document(
        self,
        request: RenderRequest,
        render_fingerprint: Fingerprint,
        chunk_seconds: int,
        max_part_seconds: int,
    ) -> tuple[RenderRequest, RenderChunkPlanDocument]:
        chunks = plan_render_chunks(
            frame_count=request.frame_count,
            target_fps=30,
            chunk_seconds=chunk_seconds,
            cues=request.cues,
        )
        parts = plan_parts_for_chunks(
            frame_count=request.frame_count,
            target_fps=30,
            max_part_seconds=max_part_seconds,
            chunks=chunks,
        )
        global_request = replace(request, parts=parts)
        document = RenderChunkPlanDocument(
            global_request.schema_version,
            global_request.job_id,
            global_request.media_digest,
            global_request.frame_count,
            global_request.width,
            global_request.height,
            global_request.dependency_path,
            global_request.dependency_digest,
            render_fingerprint,
            chunks,
            global_request.parts,
            global_request.output_has_audio,
        )
        return global_request, document

    def _commit_or_verify_plan(
        self,
        job_id: JobId,
        document: RenderChunkPlanDocument,
        writer: ArtifactWriter,
        at: str,
    ) -> None:
        raw = canonical_document_bytes(document)
        unit = self.state.get_work_unit(job_id, _PLAN_UNIT)
        if unit.status is WorkStatus.SUCCEEDED:
            artifacts = self.state.artifacts_for_unit(job_id, _PLAN_UNIT)
            if len(artifacts) != 1:
                raise ChunkedRenderError(
                    "Succeeded render plan needs exactly one artifact"
                )
            artifact = artifacts[0]
            if (
                artifact.name != _PLAN_ARTIFACT_NAME
                or artifact.relative_path
                != RENDER_CHUNK_PLAN_ARTIFACT_PATH
                or artifact.owner is not StageName.RENDER
            ):
                raise ChunkedRenderError(
                    "Stored render-plan artifact is not canonical"
                )
            expected = FileDigest(
                artifact.size_bytes,
                artifact.sha256,
            )
            stored = writer.read_verified_bytes(
                artifact.relative_path,
                expected,
                4 * 1024 * 1024,
            )
            if stored != raw:
                try:
                    stored_document = (
                        parse_render_chunk_plan_document_bytes(stored)
                    )
                    legacy_document = replace(
                        document,
                        parts=(
                            single_part_for_chunks(
                                document.frame_count,
                                document.chunks,
                            ),
                        ),
                    )
                except (RuntimeError, ValueError) as exc:
                    raise ChunkedRenderError(
                        "Stored render plan is invalid"
                    ) from exc
                if stored_document != legacy_document:
                    raise ChunkedRenderError(
                        "Succeeded render plan differs from the requested plan"
                    )
            return
        self.state.start_work_unit(job_id, _PLAN_UNIT, at)
        try:
            entry = writer.write_bytes(
                RENDER_CHUNK_PLAN_ARTIFACT_PATH,
                raw,
            )
            self.state.commit_artifact(
                job_id,
                _PLAN_UNIT,
                Artifact(
                    _PLAN_ARTIFACT_NAME,
                    RENDER_CHUNK_PLAN_ARTIFACT_PATH,
                    entry.digest.size_bytes,
                    entry.digest.sha256,
                    StageName.RENDER,
                    ("tts-document",),
                ),
                at,
            )
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            current = self.state.get_work_unit(job_id, _PLAN_UNIT)
            if current.status is WorkStatus.RUNNING:
                self.state.fail_work_unit(
                    job_id,
                    _PLAN_UNIT,
                    type(exc).__name__[:128],
                    str(exc)[:4096] or "render plan failed",
                    at,
                )
            raise

    def _canonical_chunk_artifact(
        self,
        job_id: JobId,
        chunk: RenderChunk,
    ) -> Artifact | None:
        key = _chunk_unit_key(chunk)
        unit = self.state.get_work_unit(job_id, key)
        if unit.status is not WorkStatus.SUCCEEDED:
            return None
        artifacts = self.state.artifacts_for_unit(job_id, key)
        expected_path = _chunk_artifact_path(chunk)
        if len(artifacts) != 1:
            return None
        artifact = artifacts[0]
        if (
            artifact.name != _chunk_artifact_name(chunk)
            or artifact.relative_path != expected_path
            or artifact.owner is not StageName.RENDER
            or artifact.dependencies != (_PLAN_ARTIFACT_NAME,)
        ):
            return None
        return artifact

    def _verify_chunk(
        self,
        job_id: JobId,
        request: RenderRequest,
        chunk: RenderChunk,
        workspace: Path,
        writer: ArtifactWriter,
        at: str,
    ) -> Artifact | None:
        artifact = self._canonical_chunk_artifact(job_id, chunk)
        if artifact is None:
            if (
                self.state.get_work_unit(
                    job_id,
                    _chunk_unit_key(chunk),
                ).status
                is WorkStatus.SUCCEEDED
            ):
                self.state.invalidate_work_units(
                    job_id,
                    (_chunk_unit_key(chunk),),
                    at,
                )
            return None
        expected = FileDigest(artifact.size_bytes, artifact.sha256)
        try:
            writer.verify(artifact.relative_path, expected)
            self.media.validate_render(
                workspace.joinpath(*artifact.relative_path.parts),
                chunk_local_request(request, chunk),
            )
        except (OSError, RuntimeError):
            self.state.invalidate_work_units(
                job_id,
                (_chunk_unit_key(chunk),),
                at,
            )
            return None
        return artifact

    def _render_chunk(
        self,
        *,
        job_id: JobId,
        source: Path,
        tts_wav: Path,
        request: RenderRequest,
        chunk: RenderChunk,
        workspace: Path,
        snapshot_dir: Path,
        writer: ArtifactWriter,
        source_size: int,
        at: str,
    ) -> Artifact:
        estimated = max(
            _MINIMUM_CHUNK_ESTIMATE,
            -(
                -(
                    source_size
                    * chunk.interval.frame_count
                )
                // request.frame_count
            ),
        )
        self.free_space(workspace, estimated * 3)
        key = _chunk_unit_key(chunk)
        self.state.start_work_unit(job_id, key, at)
        temporary = self._temporary_path(
            snapshot_dir,
            f"render-chunk-{chunk.index:06d}-",
        )
        try:
            self._hit(chunk, ChunkInterruptionPoint.BEFORE_RENDER)
            self.media.render_chunk(
                source,
                tts_wav,
                request,
                chunk,
                temporary,
            )
            self._hit(chunk, ChunkInterruptionPoint.AFTER_RENDER)
            entry = writer.write_file(
                _chunk_artifact_path(chunk),
                temporary,
            )
            writer.verify(_chunk_artifact_path(chunk), entry.digest)
            self.media.validate_render(
                workspace.joinpath(
                    *_chunk_artifact_path(chunk).parts
                ),
                chunk_local_request(request, chunk),
            )
            self._hit(
                chunk,
                ChunkInterruptionPoint.AFTER_FILESYSTEM_PUBLICATION,
            )
            artifact = Artifact(
                _chunk_artifact_name(chunk),
                _chunk_artifact_path(chunk),
                entry.digest.size_bytes,
                entry.digest.sha256,
                StageName.RENDER,
                (_PLAN_ARTIFACT_NAME,),
            )
            self.state.commit_artifact(
                job_id,
                key,
                artifact,
                at,
            )
            self._hit(
                chunk,
                ChunkInterruptionPoint.AFTER_SQLITE_COMMIT,
            )
            return artifact
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            current = self.state.get_work_unit(job_id, key)
            if current.status is WorkStatus.RUNNING:
                self.state.fail_work_unit(
                    job_id,
                    key,
                    type(exc).__name__[:128],
                    str(exc)[:4096] or "render chunk failed",
                    at,
                )
            raise
        finally:
            temporary.unlink(missing_ok=True)

    def _canonical_part_artifact(
        self,
        job_id: JobId,
        part: Part,
        chunks: tuple[RenderChunk, ...],
    ) -> Artifact | None:
        key = _part_unit_key(part)
        unit = self.state.get_work_unit(job_id, key)
        if unit.status is not WorkStatus.SUCCEEDED:
            return None
        artifacts = self.state.artifacts_for_unit(job_id, key)
        expected_dependencies = tuple(
            _chunk_artifact_name(chunks[index])
            for index in part.chunk_indexes
        )
        if len(artifacts) != 1:
            return None
        artifact = artifacts[0]
        if (
            artifact.name != _part_artifact_name(part)
            or artifact.relative_path != _part_artifact_path(part)
            or artifact.owner is not StageName.RENDER
            or artifact.dependencies != expected_dependencies
        ):
            return None
        return artifact

    def _verify_part(
        self,
        job_id: JobId,
        request: RenderRequest,
        part: Part,
        chunks: tuple[RenderChunk, ...],
        workspace: Path,
        writer: ArtifactWriter,
        at: str,
    ) -> Artifact | None:
        artifact = self._canonical_part_artifact(
            job_id,
            part,
            chunks,
        )
        key = _part_unit_key(part)
        if artifact is None:
            if (
                self.state.get_work_unit(job_id, key).status
                is WorkStatus.SUCCEEDED
            ):
                self.state.invalidate_work_units(job_id, (key,), at)
            return None
        expected = FileDigest(artifact.size_bytes, artifact.sha256)
        path = workspace.joinpath(*artifact.relative_path.parts)
        try:
            writer.verify(artifact.relative_path, expected)
            self.media.validate_render(
                path,
                part_local_request(request, part),
            )
        except (OSError, RuntimeError):
            self.state.invalidate_work_units(job_id, (key,), at)
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise ChunkedRenderError(
                    f"Invalid render Part could not be removed: "
                    f"{part.part_index}"
                ) from exc
            return None
        return artifact

    def _assemble_part(
        self,
        *,
        job_id: JobId,
        request: RenderRequest,
        part: Part,
        chunks: tuple[RenderChunk, ...],
        chunk_artifacts: tuple[Artifact, ...],
        workspace: Path,
        snapshot_dir: Path,
        writer: ArtifactWriter,
        at: str,
    ) -> Artifact:
        selected = tuple(
            chunk_artifacts[index]
            for index in part.chunk_indexes
        )
        concat_need = (
            sum(item.size_bytes for item in selected) * 5 + 1
        ) // 2
        self.free_space(workspace, concat_need)
        key = _part_unit_key(part)
        self.state.start_work_unit(job_id, key, at)
        temporary = self._temporary_path(
            snapshot_dir,
            f"render-part-{part.part_index:06d}-",
        )
        local_request = part_local_request(request, part)
        try:
            self.media.concatenate_render_chunks(
                tuple(
                    workspace.joinpath(*artifact.relative_path.parts)
                    for artifact in selected
                ),
                local_request,
                temporary,
            )
            path = _part_artifact_path(part)
            entry = writer.write_file(path, temporary)
            writer.verify(path, entry.digest)
            self.media.validate_render(
                workspace.joinpath(*path.parts),
                local_request,
            )
            artifact = Artifact(
                _part_artifact_name(part),
                path,
                entry.digest.size_bytes,
                entry.digest.sha256,
                StageName.RENDER,
                tuple(
                    _chunk_artifact_name(chunks[index])
                    for index in part.chunk_indexes
                ),
            )
            self.state.commit_artifact(job_id, key, artifact, at)
            return artifact
        except (KeyboardInterrupt, SystemExit):
            raise
        except BaseException as exc:
            current = self.state.get_work_unit(job_id, key)
            if current.status is WorkStatus.RUNNING:
                self.state.fail_work_unit(
                    job_id,
                    key,
                    type(exc).__name__[:128],
                    str(exc)[:4096] or "render Part assembly failed",
                    at,
                )
            raise
        finally:
            temporary.unlink(missing_ok=True)

    def prepare(
        self,
        *,
        job_id: JobId,
        source: Path,
        tts_wav: Path,
        request: RenderRequest,
        render_fingerprint: Fingerprint,
        chunk_seconds: int,
        max_part_seconds: int = MAX_PART_SECONDS,
        workspace: Path,
        snapshot_dir: Path,
        writer: ArtifactWriter,
        at: str,
        verification_observed_at: int,
    ) -> PreparedRender:
        if type(request) is not RenderRequest:
            raise ChunkedRenderError(
                "Chunk rendering requires a RenderRequest"
            )
        if type(job_id) is not JobId or request.job_id != job_id:
            raise ChunkedRenderError("Chunk render job identity is invalid")
        if type(render_fingerprint) is not Fingerprint:
            raise ChunkedRenderError(
                "Chunk rendering requires a render fingerprint"
            )
        if self.files.digest(source) != request.media_digest:
            raise ChunkedRenderError(
                "Chunk render source does not match its request"
            )
        if self.files.digest(tts_wav) != request.tts_audio_digest:
            raise ChunkedRenderError(
                "Chunk render TTS does not match its request"
            )
        archive = self.state.verified_input(job_id)
        if archive is None:
            raise ChunkedRenderError(
                "Chunk rendering requires durable input"
            )
        global_request, plan = self._plan_document(
            request,
            render_fingerprint,
            chunk_seconds,
            max_part_seconds,
        )
        self._ensure_unit(
            job_id,
            WorkUnit(
                _PLAN_UNIT,
                StageName.RENDER,
                dependencies=("tts",),
            ),
            at,
        )
        self._commit_or_verify_plan(job_id, plan, writer, at)
        chunk_keys = tuple(
            _chunk_unit_key(chunk)
            for chunk in plan.chunks
        )
        for chunk in plan.chunks:
            self._ensure_unit(
                job_id,
                WorkUnit(
                    _chunk_unit_key(chunk),
                    StageName.RENDER,
                    dependencies=(_PLAN_UNIT,),
                ),
                at,
            )
        part_keys = tuple(
            _part_unit_key(part)
            for part in plan.parts
        )
        for part in plan.parts:
            self._ensure_unit(
                job_id,
                WorkUnit(
                    _part_unit_key(part),
                    StageName.RENDER,
                    dependencies=tuple(
                        _chunk_unit_key(plan.chunks[index])
                        for index in part.chunk_indexes
                    ),
                ),
                at,
            )
        final = self.state.get_work_unit(job_id, _FINAL_UNIT)
        if final.stage is not StageName.RENDER:
            raise ChunkedRenderError(
                "Final render work unit has the wrong stage"
            )
        self.state.replace_work_unit_dependencies(
            job_id,
            _FINAL_UNIT,
            final.dependencies,
            part_keys,
            at,
        )

        reuse = self.checkpoints.latest_verified_v2(
            job_id,
            "render-chunk-",
            verification_observed_at,
        )
        artifacts: list[Artifact] = []
        for chunk in plan.chunks:
            artifact = self._verify_chunk(
                job_id,
                global_request,
                chunk,
                workspace,
                writer,
                at,
            )
            if artifact is None:
                artifact = self._render_chunk(
                    job_id=job_id,
                    source=source,
                    tts_wav=tts_wav,
                    request=global_request,
                    chunk=chunk,
                    workspace=workspace,
                    snapshot_dir=snapshot_dir,
                    writer=writer,
                    source_size=archive.source.digest.size_bytes,
                    at=at,
                )
            artifacts.append(artifact)
            checkpoint_id = (
                f"render-chunk-{chunk.index:06d}-"
                f"{render_fingerprint.sha256[:12]}-"
                f"{artifact.sha256[:12]}"
            )
            self._hit(
                chunk,
                ChunkInterruptionPoint.DURING_CHECKPOINT,
            )
            manifest = self.checkpoints.publish(
                job_id,
                checkpoint_id,
                workspace,
                snapshot_dir,
                at,
                verification_observed_at=verification_observed_at,
                verification_method=_VERIFY_METHOD,
                reuse=reuse,
            )
            if (
                type(manifest) is not CheckpointManifest
                or manifest.version != 2
                or manifest.job_id != job_id
                or manifest.checkpoint_id != checkpoint_id
            ):
                raise ChunkedRenderError(
                    "Chunk checkpoint evidence is invalid"
                )
            verified = self.checkpoints.verify_manifest(
                manifest,
                verification_observed_at,
                _VERIFY_METHOD,
            )
            if verified != manifest:
                raise ChunkedRenderError(
                    "Chunk checkpoint failed remote verification"
                )
            reuse = verified

        chunk_artifacts = tuple(artifacts)
        rendered_parts: list[RenderedPart] = []
        for part in plan.parts:
            artifact = self._verify_part(
                job_id,
                global_request,
                part,
                plan.chunks,
                workspace,
                writer,
                at,
            )
            if artifact is None:
                artifact = self._assemble_part(
                    job_id=job_id,
                    request=global_request,
                    part=part,
                    chunks=plan.chunks,
                    chunk_artifacts=chunk_artifacts,
                    workspace=workspace,
                    snapshot_dir=snapshot_dir,
                    writer=writer,
                    at=at,
                )
            rendered_parts.append(
                RenderedPart(
                    part,
                    artifact.relative_path,
                    FileDigest(artifact.size_bytes, artifact.sha256),
                )
            )
        return PreparedRender(global_request, tuple(rendered_parts))
