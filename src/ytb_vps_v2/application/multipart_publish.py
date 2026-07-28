from __future__ import annotations

import hashlib
from pathlib import Path, PurePosixPath

from ytb_vps_v2.domain.backup import FileDigest, ManifestEntry
from ytb_vps_v2.domain.models import (
    Artifact,
    JobId,
    Part,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.pipeline import (
    RENDER_PLAN_ARTIFACT_PATH,
    PublicationDocument,
    RenderPlanDocument,
    RenderedPart,
    canonical_document_bytes,
)
from ytb_vps_v2.domain.render_chunks import part_file_name
from ytb_vps_v2.ports.pipeline import (
    FileDigestVerifier,
    PartPublisher,
)
from ytb_vps_v2.ports.state import StateRepository


class MultipartPublishError(RuntimeError):
    """Raised when local output Parts cannot be published safely."""


_FINAL_UNIT = "publish"


def _part_unit_key(part: Part) -> str:
    return f"publish:part:{part.part_index:06d}"


def _render_part_unit_key(part: Part) -> str:
    return f"render:part:{part.part_index:06d}"


def _part_artifact_name(part: Part) -> str:
    return f"published-part-{part.part_index:06d}"


def _render_part_artifact_name(part: Part) -> str:
    return f"render-part-{part.part_index:06d}"


def _part_path(part: Part) -> PurePosixPath:
    return PurePosixPath("published") / part_file_name(
        part.part_index,
        part.part_count,
    )


class MultipartPublishCoordinator:
    def __init__(
        self,
        state: StateRepository,
        files: FileDigestVerifier,
    ) -> None:
        self.state = state
        self.files = files

    def _ensure_unit(
        self,
        job_id: JobId,
        part: Part,
        at: str,
    ) -> WorkUnit:
        expected = WorkUnit(
            _part_unit_key(part),
            StageName.PUBLISH,
            dependencies=(_render_part_unit_key(part),),
        )
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
            raise MultipartPublishError(
                f"Stored work unit conflicts with {expected.key}"
            )
        return unit

    def _canonical_artifact(
        self,
        job_id: JobId,
        part: Part,
    ) -> Artifact | None:
        key = _part_unit_key(part)
        unit = self.state.get_work_unit(job_id, key)
        if unit.status is not WorkStatus.SUCCEEDED:
            return None
        artifacts = self.state.artifacts_for_unit(job_id, key)
        if len(artifacts) != 1:
            return None
        artifact = artifacts[0]
        if (
            artifact.name != _part_artifact_name(part)
            or artifact.relative_path != _part_path(part)
            or artifact.owner is not StageName.PUBLISH
            or artifact.dependencies
            != (_render_part_artifact_name(part),)
        ):
            return None
        return artifact

    def _verify_part(
        self,
        job_id: JobId,
        rendered: RenderedPart,
        workspace: Path,
        at: str,
    ) -> Artifact | None:
        part = rendered.part
        key = _part_unit_key(part)
        artifact = self._canonical_artifact(job_id, part)
        if artifact is None:
            if (
                self.state.get_work_unit(job_id, key).status
                is WorkStatus.SUCCEEDED
            ):
                self.state.invalidate_work_units(job_id, (key,), at)
            return None
        path = workspace.joinpath(*artifact.relative_path.parts)
        expected = FileDigest(artifact.size_bytes, artifact.sha256)
        try:
            actual = self.files.digest(path)
        except (OSError, RuntimeError):
            actual = None
        if actual == expected and expected == rendered.digest:
            return artifact
        self.state.invalidate_work_units(job_id, (key,), at)
        try:
            path.unlink(missing_ok=True)
        except OSError as exc:
            raise MultipartPublishError(
                f"Invalid published Part could not be removed: "
                f"{part.part_index}"
            ) from exc
        return None

    def _publish_part(
        self,
        *,
        job_id: JobId,
        rendered: RenderedPart,
        workspace: Path,
        publisher: PartPublisher,
        at: str,
    ) -> Artifact:
        part = rendered.part
        key = _part_unit_key(part)
        source = workspace.joinpath(*rendered.path.parts)
        if self.files.digest(source) != rendered.digest:
            raise MultipartPublishError(
                f"Rendered Part changed before publication: "
                f"{part.part_index}"
            )
        self.state.start_work_unit(job_id, key, at)
        try:
            entry = publisher.publish(source, part)
            if (
                type(entry) is not ManifestEntry
                or entry.key != _part_path(part)
                or entry.digest != rendered.digest
                or self.files.digest(
                    workspace.joinpath(*entry.key.parts)
                )
                != entry.digest
            ):
                raise MultipartPublishError(
                    f"Published Part evidence is invalid: "
                    f"{part.part_index}"
                )
            artifact = Artifact(
                _part_artifact_name(part),
                entry.key,
                entry.digest.size_bytes,
                entry.digest.sha256,
                StageName.PUBLISH,
                (_render_part_artifact_name(part),),
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
                    str(exc)[:4096] or "publish Part failed",
                    at,
                )
            raise

    def prepare(
        self,
        *,
        job_id: JobId,
        plan: RenderPlanDocument,
        workspace: Path,
        publisher: PartPublisher,
        at: str,
    ) -> PublicationDocument:
        if type(plan) is not RenderPlanDocument:
            raise MultipartPublishError(
                "Multipart publication requires a RenderPlanDocument"
            )
        if type(job_id) is not JobId or plan.job_id != job_id:
            raise MultipartPublishError(
                "Multipart publication job identity is invalid"
            )
        if not isinstance(workspace, Path) or not workspace.is_dir():
            raise MultipartPublishError(
                "Multipart publication workspace is invalid"
            )
        for rendered in plan.rendered_parts:
            self._ensure_unit(job_id, rendered.part, at)
        part_keys = tuple(
            _part_unit_key(rendered.part)
            for rendered in plan.rendered_parts
        )
        final = self.state.get_work_unit(job_id, _FINAL_UNIT)
        if final.stage is not StageName.PUBLISH:
            raise MultipartPublishError(
                "Final publish work unit has the wrong stage"
            )
        if final.dependencies != part_keys:
            self.state.replace_work_unit_dependencies(
                job_id,
                _FINAL_UNIT,
                final.dependencies,
                part_keys,
                at,
            )

        published: list[Artifact] = []
        for rendered in plan.rendered_parts:
            artifact = self._verify_part(
                job_id,
                rendered,
                workspace,
                at,
            )
            if artifact is None:
                artifact = self._publish_part(
                    job_id=job_id,
                    rendered=rendered,
                    workspace=workspace,
                    publisher=publisher,
                    at=at,
                )
            published.append(artifact)

        raw = canonical_document_bytes(plan)
        return PublicationDocument(
            plan.schema_version,
            plan.job_id,
            plan.media_digest,
            plan.frame_count,
            plan.width,
            plan.height,
            RENDER_PLAN_ARTIFACT_PATH,
            FileDigest(
                len(raw),
                hashlib.sha256(raw).hexdigest(),
            ),
            plan.parts,
            tuple(item.relative_path for item in published),
            tuple(
                FileDigest(item.size_bytes, item.sha256)
                for item in published
            ),
        )
