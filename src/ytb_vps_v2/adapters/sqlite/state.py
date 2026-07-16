from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from ytb_vps_v2.adapters.sqlite.schema import StateStoreError, connect_database
from ytb_vps_v2.domain.fingerprints import Fingerprint, StageConfigFingerprint
from ytb_vps_v2.domain.models import JobId, StageName, WorkStatus, WorkUnit
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
