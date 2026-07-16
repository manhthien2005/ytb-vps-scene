from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.sqlite.schema import StateStoreError, connect_database
from ytb_vps_v2.application.invalidation import InvalidationPlan
from ytb_vps_v2.domain.fingerprints import Fingerprint, StageConfigFingerprint
from ytb_vps_v2.domain.models import (
    Artifact,
    JobId,
    StageName,
    WorkStatus,
    WorkUnit,
)
from ytb_vps_v2.domain.state import RetryEvent, StateTransitionError


def _text(name: str, value: object, maximum: int = 512) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value) > maximum
    ):
        raise StateStoreError(
            f"{name} must be non-empty, trimmed, and at most {maximum} characters"
        )
    return value


def _job_id(value: object) -> JobId:
    if type(value) is not JobId:
        raise StateStoreError("Job ID must be JobId")
    return value


def _config_snapshot(
    values: object,
) -> dict[StageName, Fingerprint]:
    if not isinstance(values, tuple) or any(
        not isinstance(item, StageConfigFingerprint) for item in values
    ):
        raise StateStoreError(
            "Configuration snapshot must contain StageConfigFingerprint values"
        )
    snapshot = {item.stage: item.fingerprint for item in values}
    if len(values) != len(snapshot) or set(snapshot) != set(StageName):
        raise StateStoreError("Configuration snapshot must contain every stage once")
    return snapshot


class SqliteStateStore:
    def __init__(self, path: Path) -> None:
        self.connection: sqlite3.Connection | None = connect_database(path)

    def __enter__(self) -> SqliteStateStore:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def close(self) -> None:
        if self.connection is not None:
            self.connection.close()
            self.connection = None

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        connection = self.connection
        if connection is None:
            raise StateStoreError("State store is closed")
        try:
            connection.execute("BEGIN IMMEDIATE")
            yield connection
            connection.commit()
        except (StateStoreError, StateTransitionError):
            if connection.in_transaction:
                connection.rollback()
            raise
        except sqlite3.DatabaseError as exc:
            if connection.in_transaction:
                connection.rollback()
            raise StateStoreError("SQLite state transaction failed") from exc

    def create_job(
        self,
        job_id: JobId,
        source_fingerprint: Fingerprint,
        config_fingerprints: tuple[StageConfigFingerprint, ...],
        at: str,
    ) -> None:
        job = _job_id(job_id)
        if type(source_fingerprint) is not Fingerprint:
            raise StateStoreError("Source fingerprint must be Fingerprint")
        snapshot = _config_snapshot(config_fingerprints)
        timestamp = _text("Job timestamp", at, 128)
        with self._transaction() as connection:
            existing = connection.execute(
                "SELECT source_sha256 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone()
            if existing is None:
                connection.execute(
                    "INSERT INTO jobs(job_id, source_sha256, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?)",
                    (job.value, source_fingerprint.sha256, timestamp, timestamp),
                )
                connection.executemany(
                    "INSERT INTO config_fingerprints(job_id, stage, sha256) "
                    "VALUES (?, ?, ?)",
                    (
                        (job.value, stage.value, snapshot[stage].sha256)
                        for stage in StageName
                    ),
                )
                return
            if existing["source_sha256"] != source_fingerprint.sha256:
                raise StateStoreError("Job identity conflicts with stored source")
            stored = {
                StageName(row["stage"]): row["sha256"]
                for row in connection.execute(
                    "SELECT stage, sha256 FROM config_fingerprints WHERE job_id=?",
                    (job.value,),
                )
            }
            expected = {stage: value.sha256 for stage, value in snapshot.items()}
            if stored != expected:
                raise StateStoreError("Job configuration conflicts with stored snapshot")

    def put_work_unit(self, job_id: JobId, unit: WorkUnit, at: str) -> None:
        job = _job_id(job_id)
        if type(unit) is not WorkUnit:
            raise StateStoreError("Work unit must be WorkUnit")
        if unit.status is not WorkStatus.PENDING or unit.attempts != 0:
            raise StateStoreError("New work unit must be pending with zero attempts")
        timestamp = _text("Work unit timestamp", at, 128)
        with self._transaction() as connection:
            existing = connection.execute(
                "SELECT stage, status, attempts FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, unit.key),
            ).fetchone()
            if existing is None:
                connection.execute(
                    "INSERT INTO work_units("
                    "job_id, unit_key, stage, status, attempts, updated_at"
                    ") VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        job.value,
                        unit.key,
                        unit.stage.value,
                        unit.status.value,
                        unit.attempts,
                        timestamp,
                    ),
                )
                return
            if (
                existing["stage"] != unit.stage.value
                or existing["status"] != unit.status.value
                or existing["attempts"] != unit.attempts
            ):
                raise StateStoreError("Work unit conflicts with stored state")

    def _unit_from_row(self, row: sqlite3.Row) -> WorkUnit:
        return WorkUnit(
            row["unit_key"],
            StageName(row["stage"]),
            WorkStatus(row["status"]),
            row["attempts"],
        )

    def get_work_unit(self, job_id: JobId, unit_key: str) -> WorkUnit:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            row = self.connection.execute(
                "SELECT unit_key, stage, status, attempts FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
        except sqlite3.DatabaseError as exc:
            raise StateStoreError("Unable to read work unit") from exc
        if row is None:
            raise StateStoreError(f"Work unit does not exist: {key}")
        return self._unit_from_row(row)

    def start_work_unit(self, job_id: JobId, unit_key: str, at: str) -> WorkUnit:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        timestamp = _text("Work unit timestamp", at, 128)
        with self._transaction() as connection:
            cursor = connection.execute(
                "UPDATE work_units SET status=?, attempts=attempts+1, "
                "error_kind=NULL, error_message=NULL, updated_at=? "
                "WHERE job_id=? AND unit_key=? AND status IN (?, ?, ?)",
                (
                    WorkStatus.RUNNING.value,
                    timestamp,
                    job.value,
                    key,
                    WorkStatus.PENDING.value,
                    WorkStatus.FAILED.value,
                    WorkStatus.INVALID.value,
                ),
            )
            if cursor.rowcount != 1:
                raise StateTransitionError(f"Work unit cannot start: {key}")
            row = connection.execute(
                "SELECT unit_key, stage, status, attempts FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
            return self._unit_from_row(row)

    def fail_work_unit(
        self,
        job_id: JobId,
        unit_key: str,
        error_kind: str,
        error_message: str,
        at: str,
    ) -> WorkUnit:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        kind = _text("Error kind", error_kind, 128)
        message = _text("Error message", error_message, 4096)
        timestamp = _text("Failure timestamp", at, 128)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT unit_key, stage, status, attempts FROM work_units "
                "WHERE job_id=? AND unit_key=? AND status=?",
                (job.value, key, WorkStatus.RUNNING.value),
            ).fetchone()
            if row is None:
                raise StateTransitionError(f"Work unit cannot fail: {key}")
            connection.execute(
                "UPDATE work_units SET status=?, error_kind=?, error_message=?, "
                "updated_at=? WHERE job_id=? AND unit_key=? AND status=?",
                (
                    WorkStatus.FAILED.value,
                    kind,
                    message,
                    timestamp,
                    job.value,
                    key,
                    WorkStatus.RUNNING.value,
                ),
            )
            connection.execute(
                "INSERT INTO retry_events("
                "job_id, unit_key, stage, attempt, error_kind, error_message, recorded_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?)",
                (job.value, key, row["stage"], row["attempts"], kind, message, timestamp),
            )
            return WorkUnit(
                key,
                StageName(row["stage"]),
                WorkStatus.FAILED,
                row["attempts"],
            )

    def recover_stale_work(self, at: str) -> tuple[tuple[JobId, str], ...]:
        timestamp = _text("Recovery timestamp", at, 128)
        with self._transaction() as connection:
            rows = connection.execute(
                "SELECT job_id, unit_key FROM work_units WHERE status=? "
                "ORDER BY job_id, unit_key",
                (WorkStatus.RUNNING.value,),
            ).fetchall()
            connection.execute(
                "UPDATE work_units SET status=?, error_kind=NULL, error_message=NULL, "
                "updated_at=? WHERE status=?",
                (
                    WorkStatus.PENDING.value,
                    timestamp,
                    WorkStatus.RUNNING.value,
                ),
            )
            return tuple((JobId(row["job_id"]), row["unit_key"]) for row in rows)

    def retry_events(self, job_id: JobId, unit_key: str) -> tuple[RetryEvent, ...]:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            rows = self.connection.execute(
                "SELECT stage, attempt, error_kind, error_message, recorded_at "
                "FROM retry_events WHERE job_id=? AND unit_key=? ORDER BY event_id",
                (job.value, key),
            ).fetchall()
        except sqlite3.DatabaseError as exc:
            raise StateStoreError("Unable to read retry events") from exc
        return tuple(
            RetryEvent(
                job,
                key,
                StageName(row["stage"]),
                row["attempt"],
                row["error_kind"],
                row["error_message"],
                row["recorded_at"],
            )
            for row in rows
        )

    def commit_artifact(
        self,
        job_id: JobId,
        unit_key: str,
        artifact: Artifact,
        at: str,
    ) -> None:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        if type(artifact) is not Artifact:
            raise StateStoreError("Committed artifact must be Artifact")
        timestamp = _text("Artifact commit timestamp", at, 128)
        dependencies_json = json.dumps(
            artifact.dependencies,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT stage, status FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
            if row is None or row["status"] != WorkStatus.RUNNING.value:
                raise StateTransitionError(
                    f"Artifact owner work unit is not running: {key}"
                )
            if row["stage"] != artifact.owner.value:
                raise StateTransitionError(
                    f"Artifact owner does not match work unit stage: {key}"
                )
            connection.execute(
                "INSERT INTO artifacts("
                "job_id, name, relative_path, size_bytes, sha256, owner_stage, "
                "dependencies_json, is_valid, committed_at"
                ") VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)",
                (
                    job.value,
                    artifact.name,
                    str(artifact.relative_path),
                    artifact.size_bytes,
                    artifact.sha256,
                    artifact.owner.value,
                    dependencies_json,
                    timestamp,
                ),
            )
            cursor = connection.execute(
                "UPDATE work_units SET status=?, error_kind=NULL, "
                "error_message=NULL, updated_at=? "
                "WHERE job_id=? AND unit_key=? AND status=?",
                (
                    WorkStatus.SUCCEEDED.value,
                    timestamp,
                    job.value,
                    key,
                    WorkStatus.RUNNING.value,
                ),
            )
            if cursor.rowcount != 1:
                raise StateTransitionError(
                    f"Work unit changed before artifact commit: {key}"
                )

    def valid_artifacts(self, job_id: JobId) -> tuple[Artifact, ...]:
        job = _job_id(job_id)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            rows = self.connection.execute(
                "SELECT name, relative_path, size_bytes, sha256, owner_stage, "
                "dependencies_json FROM artifacts "
                "WHERE job_id=? AND is_valid=1 ORDER BY name",
                (job.value,),
            ).fetchall()
            return tuple(
                Artifact(
                    row["name"],
                    PurePosixPath(row["relative_path"]),
                    row["size_bytes"],
                    row["sha256"],
                    StageName(row["owner_stage"]),
                    tuple(json.loads(row["dependencies_json"])),
                )
                for row in rows
            )
        except (sqlite3.DatabaseError, ValueError, TypeError) as exc:
            raise StateStoreError("Unable to read valid artifacts") from exc

    def apply_invalidation(
        self,
        job_id: JobId,
        plan: InvalidationPlan,
        at: str,
    ) -> tuple[str, ...]:
        job = _job_id(job_id)
        if type(plan) is not InvalidationPlan:
            raise StateStoreError("Invalidation must be InvalidationPlan")
        timestamp = _text("Invalidation timestamp", at, 128)
        if not plan.affected_stages:
            return ()
        stages = tuple(stage.value for stage in plan.affected_stages)
        placeholders = ",".join("?" for _ in stages)
        with self._transaction() as connection:
            job_exists = connection.execute(
                "SELECT 1 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone()
            if job_exists is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            rows = connection.execute(
                f"SELECT unit_key FROM work_units WHERE job_id=? "
                f"AND stage IN ({placeholders}) AND status<>? ORDER BY unit_key",
                (job.value, *stages, WorkStatus.INVALID.value),
            ).fetchall()
            connection.execute(
                f"UPDATE work_units SET status=?, error_kind=NULL, "
                f"error_message=NULL, updated_at=? WHERE job_id=? "
                f"AND stage IN ({placeholders}) AND status<>?",
                (
                    WorkStatus.INVALID.value,
                    timestamp,
                    job.value,
                    *stages,
                    WorkStatus.INVALID.value,
                ),
            )
            connection.execute(
                f"UPDATE artifacts SET is_valid=0 WHERE job_id=? "
                f"AND owner_stage IN ({placeholders}) AND is_valid=1",
                (job.value, *stages),
            )
            return tuple(row["unit_key"] for row in rows)
