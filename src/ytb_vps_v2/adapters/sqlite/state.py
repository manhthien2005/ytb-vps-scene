from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path, PurePosixPath

from ytb_vps_v2.adapters.sqlite.schema import StateStoreError, connect_database
from ytb_vps_v2.domain.backup import (
    CheckpointRecord,
    FileDigest,
    ManifestEntry,
    SourceIdentity,
    VerifiedInputArchive,
)
from ytb_vps_v2.domain.errors import DomainInvariantError
from ytb_vps_v2.domain.fingerprints import Fingerprint, StageConfigFingerprint
from ytb_vps_v2.domain.invalidation import InvalidationPlan, STAGE_ORDER
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

    def create_snapshot(
        self, destination: Path, key: PurePosixPath
    ) -> ManifestEntry:
        if self.connection is None:
            raise StateStoreError("State store is closed")
        from ytb_vps_v2.adapters.sqlite.backup import create_sqlite_snapshot

        return create_sqlite_snapshot(self.connection, destination, key)

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
        except BaseException as exc:
            if connection.in_transaction:
                connection.rollback()
            if isinstance(exc, (ValueError, TypeError)):
                raise StateStoreError("Stored SQLite state is invalid") from exc
            raise

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

    def stored_config_fingerprints(
        self,
        job_id: JobId,
    ) -> tuple[StageConfigFingerprint, ...] | None:
        job = _job_id(job_id)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            if self.connection.execute(
                "SELECT 1 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone() is None:
                return None
            rows = self.connection.execute(
                "SELECT stage, sha256 FROM config_fingerprints "
                "WHERE job_id=? ORDER BY stage",
                (job.value,),
            ).fetchall()
            values = {
                StageName(row["stage"]): Fingerprint(row["sha256"])
                for row in rows
            }
            if len(rows) != len(values) or set(values) != set(StageName):
                raise StateStoreError(
                    "Stored configuration snapshot is incomplete"
                )
            return tuple(
                StageConfigFingerprint(stage, values[stage])
                for stage in StageName
            )
        except StateStoreError:
            raise
        except (
            sqlite3.DatabaseError,
            DomainInvariantError,
            ValueError,
            TypeError,
        ) as exc:
            raise StateStoreError(
                "Unable to read stored configuration snapshot"
            ) from exc

    def reconfigure_job(
        self,
        job_id: JobId,
        previous: tuple[StageConfigFingerprint, ...],
        current: tuple[StageConfigFingerprint, ...],
        plan: InvalidationPlan,
        at: str,
    ) -> tuple[str, ...]:
        job = _job_id(job_id)
        old = _config_snapshot(previous)
        new = _config_snapshot(current)
        if type(plan) is not InvalidationPlan:
            raise StateStoreError("Invalidation must be InvalidationPlan")
        direct = tuple(
            stage
            for stage in StageName
            if old[stage] != new[stage]
        )
        if direct != plan.direct_stages:
            raise StateStoreError(
                "Invalidation does not match configuration change"
            )
        timestamp = _text("Reconfiguration timestamp", at, 128)
        with self._transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone() is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            rows = connection.execute(
                "SELECT stage, sha256 FROM config_fingerprints "
                "WHERE job_id=?",
                (job.value,),
            ).fetchall()
            try:
                stored = {
                    StageName(row["stage"]): Fingerprint(row["sha256"])
                    for row in rows
                }
            except (DomainInvariantError, ValueError, TypeError) as exc:
                raise StateStoreError(
                    "Stored configuration snapshot is invalid"
                ) from exc
            if len(rows) != len(stored) or set(stored) != set(StageName):
                raise StateStoreError(
                    "Stored configuration snapshot is incomplete"
                )
            if any(stored[stage] != old[stage] for stage in StageName):
                raise StateStoreError(
                    "Stored configuration changed before reconfiguration"
                )

            affected_rows: tuple[sqlite3.Row, ...] = ()
            if plan.affected_stages:
                stages = tuple(
                    stage.value
                    for stage in plan.affected_stages
                )
                placeholders = ",".join("?" for _ in stages)
                affected_rows = tuple(
                    connection.execute(
                        f"SELECT unit_key FROM work_units WHERE job_id=? "
                        f"AND stage IN ({placeholders}) AND status<>? "
                        f"ORDER BY unit_key",
                        (
                            job.value,
                            *stages,
                            WorkStatus.INVALID.value,
                        ),
                    ).fetchall()
                )
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
                    f"AND unit_key IN ("
                    f"SELECT unit_key FROM work_units WHERE job_id=? "
                    f"AND stage IN ({placeholders})"
                    f") AND is_valid=1",
                    (job.value, job.value, *stages),
                )

            for stage in StageName:
                cursor = connection.execute(
                    "UPDATE config_fingerprints SET sha256=? "
                    "WHERE job_id=? AND stage=?",
                    (new[stage].sha256, job.value, stage.value),
                )
                if cursor.rowcount != 1:
                    raise StateStoreError(
                        "Configuration snapshot changed during update"
                    )
            connection.execute(
                "UPDATE jobs SET updated_at=? WHERE job_id=?",
                (timestamp, job.value),
            )
            return tuple(row["unit_key"] for row in affected_rows)

    def record_verified_input(
        self,
        job_id: JobId,
        evidence: VerifiedInputArchive,
    ) -> None:
        job = _job_id(job_id)
        if type(evidence) is not VerifiedInputArchive:
            raise StateStoreError("Verified input must be VerifiedInputArchive")
        with self._transaction() as connection:
            stored_job = connection.execute(
                "SELECT source_sha256 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone()
            if stored_job is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            if stored_job["source_sha256"] != evidence.source.digest.sha256:
                raise StateStoreError(
                    "Verified input does not match the job source identity"
                )
            existing = connection.execute(
                "SELECT source_name, archive_key, size_bytes, sha256 "
                "FROM input_archives WHERE job_id=?",
                (job.value,),
            ).fetchone()
            values = (
                evidence.source.name,
                str(evidence.archive.key),
                evidence.archive.digest.size_bytes,
                evidence.archive.digest.sha256,
            )
            if existing is None:
                connection.execute(
                    "INSERT INTO input_archives("
                    "job_id, source_name, archive_key, size_bytes, sha256, verified_at"
                    ") VALUES (?, ?, ?, ?, ?, ?)",
                    (job.value, *values, evidence.verified_at),
                )
                return
            stored = (
                existing["source_name"],
                existing["archive_key"],
                existing["size_bytes"],
                existing["sha256"],
            )
            if stored != values:
                raise StateStoreError("Verified input conflicts with stored archive")

    def verified_input(self, job_id: JobId) -> VerifiedInputArchive | None:
        job = _job_id(job_id)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            row = self.connection.execute(
                "SELECT j.source_sha256, i.source_name, i.archive_key, "
                "i.size_bytes, i.sha256, i.verified_at "
                "FROM jobs j LEFT JOIN input_archives i ON i.job_id=j.job_id "
                "WHERE j.job_id=?",
                (job.value,),
            ).fetchone()
            if row is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            if row["archive_key"] is None:
                return None
            digest = FileDigest(row["size_bytes"], row["sha256"])
            if digest.sha256 != row["source_sha256"]:
                raise StateStoreError("Stored input archive does not match job source")
            return VerifiedInputArchive(
                SourceIdentity(row["source_name"], digest),
                ManifestEntry(PurePosixPath(row["archive_key"]), digest),
                row["verified_at"],
            )
        except StateStoreError:
            raise
        except (sqlite3.DatabaseError, DomainInvariantError, ValueError, TypeError) as exc:
            raise StateStoreError("Unable to read verified input") from exc

    def record_checkpoint(
        self,
        job_id: JobId,
        checkpoint_id: str,
        manifest: ManifestEntry,
        state_snapshot: ManifestEntry,
        at: str,
    ) -> None:
        job = _job_id(job_id)
        identifier = _text("Checkpoint ID", checkpoint_id, 128)
        if type(manifest) is not ManifestEntry:
            raise StateStoreError("Checkpoint manifest must be ManifestEntry")
        if type(state_snapshot) is not ManifestEntry:
            raise StateStoreError("Checkpoint state snapshot must be ManifestEntry")
        timestamp = _text("Checkpoint completion time", at, 128)
        try:
            record = CheckpointRecord(
                job, identifier, manifest, state_snapshot, timestamp
            )
        except DomainInvariantError as exc:
            raise StateStoreError("Checkpoint evidence is invalid") from exc
        with self._transaction() as connection:
            durable_input = connection.execute(
                "SELECT 1 FROM input_archives i JOIN jobs j ON j.job_id=i.job_id "
                "WHERE i.job_id=? AND i.sha256=j.source_sha256",
                (job.value,),
            ).fetchone()
            if durable_input is None:
                raise StateStoreError(
                    "Checkpoint requires matching verified input evidence"
                )
            existing = connection.execute(
                "SELECT manifest_key, manifest_size_bytes, manifest_sha256, "
                "state_key, state_size_bytes, state_sha256 "
                "FROM checkpoint_snapshots WHERE job_id=? AND checkpoint_id=?",
                (job.value, identifier),
            ).fetchone()
            values = (
                str(record.manifest.key),
                record.manifest.digest.size_bytes,
                record.manifest.digest.sha256,
                str(record.state_snapshot.key),
                record.state_snapshot.digest.size_bytes,
                record.state_snapshot.digest.sha256,
            )
            if existing is None:
                connection.execute(
                    "INSERT INTO checkpoint_snapshots("
                    "job_id, checkpoint_id, manifest_key, manifest_size_bytes, "
                    "manifest_sha256, state_key, state_size_bytes, state_sha256, "
                    "completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (job.value, identifier, *values, timestamp),
                )
                return
            stored = tuple(existing[index] for index in range(6))
            if stored != values:
                raise StateStoreError("Checkpoint evidence conflicts with stored record")

    def completed_checkpoints(
        self, job_id: JobId
    ) -> tuple[CheckpointRecord, ...]:
        job = _job_id(job_id)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            if self.connection.execute(
                "SELECT 1 FROM jobs WHERE job_id=?", (job.value,)
            ).fetchone() is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            rows = self.connection.execute(
                "SELECT checkpoint_id, manifest_key, manifest_size_bytes, "
                "manifest_sha256, state_key, state_size_bytes, state_sha256, "
                "completed_at FROM checkpoint_snapshots WHERE job_id=? "
                "ORDER BY checkpoint_id",
                (job.value,),
            ).fetchall()
            return tuple(
                CheckpointRecord(
                    job,
                    row["checkpoint_id"],
                    ManifestEntry(
                        PurePosixPath(row["manifest_key"]),
                        FileDigest(
                            row["manifest_size_bytes"], row["manifest_sha256"]
                        ),
                    ),
                    ManifestEntry(
                        PurePosixPath(row["state_key"]),
                        FileDigest(row["state_size_bytes"], row["state_sha256"]),
                    ),
                    row["completed_at"],
                )
                for row in rows
            )
        except StateStoreError:
            raise
        except (sqlite3.DatabaseError, DomainInvariantError, ValueError, TypeError) as exc:
            raise StateStoreError("Unable to read checkpoint evidence") from exc

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
                if unit.dependencies:
                    placeholders = ",".join("?" for _ in unit.dependencies)
                    rows = connection.execute(
                        f"SELECT unit_key FROM work_units WHERE job_id=? "
                        f"AND unit_key IN ({placeholders}) ORDER BY unit_key",
                        (job.value, *unit.dependencies),
                    ).fetchall()
                    if tuple(row["unit_key"] for row in rows) != unit.dependencies:
                        raise StateStoreError(
                            "Work unit dependency does not exist for this job"
                        )
                    connection.executemany(
                        "INSERT INTO work_unit_dependencies("
                        "job_id, unit_key, depends_on_key"
                        ") VALUES (?, ?, ?)",
                        (
                            (job.value, unit.key, dependency)
                            for dependency in unit.dependencies
                        ),
                    )
                return
            dependencies = self._dependencies_for_unit(
                connection,
                job.value,
                unit.key,
            )
            if (
                existing["stage"] != unit.stage.value
                or existing["status"] != unit.status.value
                or existing["attempts"] != unit.attempts
                or dependencies != unit.dependencies
            ):
                raise StateStoreError("Work unit conflicts with stored state")

    def _dependencies_for_unit(
        self,
        connection: sqlite3.Connection,
        job_id: str,
        unit_key: str,
    ) -> tuple[str, ...]:
        return tuple(
            row["depends_on_key"]
            for row in connection.execute(
                "SELECT depends_on_key FROM work_unit_dependencies "
                "WHERE job_id=? AND unit_key=? ORDER BY depends_on_key",
                (job_id, unit_key),
            ).fetchall()
        )

    def _unit_from_row(
        self,
        row: sqlite3.Row,
        dependencies: tuple[str, ...],
    ) -> WorkUnit:
        return WorkUnit(
            row["unit_key"],
            StageName(row["stage"]),
            WorkStatus(row["status"]),
            row["attempts"],
            dependencies,
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
        dependencies = self._dependencies_for_unit(
            self.connection,
            job.value,
            key,
        )
        return self._unit_from_row(row, dependencies)

    def work_units(self, job_id: JobId) -> tuple[WorkUnit, ...]:
        job = _job_id(job_id)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            if self.connection.execute(
                "SELECT 1 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone() is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            rows = self.connection.execute(
                "SELECT unit_key, stage, status, attempts FROM work_units "
                "WHERE job_id=? ORDER BY unit_key",
                (job.value,),
            ).fetchall()
            return tuple(
                self._unit_from_row(
                    row,
                    self._dependencies_for_unit(
                        self.connection,
                        job.value,
                        row["unit_key"],
                    ),
                )
                for row in rows
            )
        except StateStoreError:
            raise
        except (sqlite3.DatabaseError, DomainInvariantError, ValueError) as exc:
            raise StateStoreError("Unable to read work units") from exc

    def replace_work_unit_dependencies(
        self,
        job_id: JobId,
        unit_key: str,
        expected: tuple[str, ...],
        current: tuple[str, ...],
        at: str,
    ) -> None:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        timestamp = _text("Work unit timestamp", at, 128)
        for name, values in (
            ("Expected dependencies", expected),
            ("Current dependencies", current),
        ):
            if (
                type(values) is not tuple
                or any(
                    type(value) is not str
                    or not value
                    or value != value.strip()
                    or len(value) > 512
                    for value in values
                )
                or tuple(sorted(set(values))) != values
            ):
                raise StateStoreError(
                    f"{name} must be ordered unique work-unit keys"
                )
        if key in current:
            raise StateStoreError("Work unit cannot depend on itself")

        with self._transaction() as connection:
            row = connection.execute(
                "SELECT stage, status, attempts FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
            if row is None:
                raise StateStoreError(f"Work unit does not exist: {key}")
            if row["status"] not in {
                WorkStatus.PENDING.value,
                WorkStatus.FAILED.value,
                WorkStatus.INVALID.value,
            }:
                raise StateStoreError(
                    "Work-unit dependencies cannot change in its current state"
                )
            stored = self._dependencies_for_unit(
                connection,
                job.value,
                key,
            )
            if stored != expected:
                raise StateStoreError(
                    "Work-unit dependency compare-and-swap failed"
                )
            if current:
                placeholders = ",".join("?" for _ in current)
                dependencies = connection.execute(
                    f"SELECT unit_key FROM work_units WHERE job_id=? "
                    f"AND unit_key IN ({placeholders}) ORDER BY unit_key",
                    (job.value, *current),
                ).fetchall()
                if (
                    tuple(item["unit_key"] for item in dependencies)
                    != current
                ):
                    raise StateStoreError(
                        "Work unit dependency does not exist for this job"
                    )

            unit_rows = connection.execute(
                "SELECT unit_key FROM work_units WHERE job_id=? "
                "ORDER BY unit_key",
                (job.value,),
            ).fetchall()
            graph = {
                item["unit_key"]: self._dependencies_for_unit(
                    connection,
                    job.value,
                    item["unit_key"],
                )
                for item in unit_rows
            }
            graph[key] = current
            visiting: set[str] = set()
            visited: set[str] = set()

            def visit(node: str) -> None:
                if node in visiting:
                    raise StateStoreError(
                        "Work-unit dependency graph contains a cycle"
                    )
                if node in visited:
                    return
                visiting.add(node)
                for dependency in graph[node]:
                    visit(dependency)
                visiting.remove(node)
                visited.add(node)

            for node in graph:
                visit(node)

            connection.execute(
                "DELETE FROM work_unit_dependencies "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            )
            connection.executemany(
                "INSERT INTO work_unit_dependencies("
                "job_id, unit_key, depends_on_key"
                ") VALUES (?, ?, ?)",
                (
                    (job.value, key, dependency)
                    for dependency in current
                ),
            )
            connection.execute(
                "UPDATE work_units SET updated_at=? "
                "WHERE job_id=? AND unit_key=?",
                (timestamp, job.value, key),
            )

    def start_work_unit(self, job_id: JobId, unit_key: str, at: str) -> WorkUnit:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        timestamp = _text("Work unit timestamp", at, 128)
        with self._transaction() as connection:
            current = connection.execute(
                "SELECT stage FROM work_units WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
            if current is None:
                raise StateTransitionError(f"Work unit cannot start: {key}")
            if current["stage"] != StageName.INGEST.value:
                durable_input = connection.execute(
                    "SELECT 1 FROM input_archives i JOIN jobs j ON j.job_id=i.job_id "
                    "WHERE i.job_id=? AND i.sha256=j.source_sha256",
                    (job.value,),
                ).fetchone()
                if durable_input is None:
                    raise StateTransitionError(
                        f"Work unit requires durable input before start: {key}"
                    )
            blocked = connection.execute(
                "SELECT d.depends_on_key "
                "FROM work_unit_dependencies d "
                "JOIN work_units u "
                "ON u.job_id=d.job_id AND u.unit_key=d.depends_on_key "
                "WHERE d.job_id=? AND d.unit_key=? AND u.status<>? "
                "LIMIT 1",
                (job.value, key, WorkStatus.SUCCEEDED.value),
            ).fetchone()
            if blocked is not None:
                raise StateTransitionError(
                    f"Work unit dependency has not succeeded: "
                    f"{blocked['depends_on_key']}"
                )
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
            return self._unit_from_row(
                row,
                self._dependencies_for_unit(connection, job.value, key),
            )

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
            failed = connection.execute(
                "SELECT unit_key, stage, status, attempts FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
            return self._unit_from_row(
                failed,
                self._dependencies_for_unit(connection, job.value, key),
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
        self.commit_artifacts(job_id, unit_key, (artifact,), at)

    def commit_artifacts(
        self,
        job_id: JobId,
        unit_key: str,
        artifacts: tuple[Artifact, ...],
        at: str,
    ) -> None:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        if (
            type(artifacts) is not tuple
            or not artifacts
            or any(type(artifact) is not Artifact for artifact in artifacts)
        ):
            raise StateStoreError(
                "Committed artifacts must be a non-empty Artifact tuple"
            )
        names = tuple(artifact.name for artifact in artifacts)
        paths = tuple(str(artifact.relative_path) for artifact in artifacts)
        if len(set(names)) != len(names) or len(set(paths)) != len(paths):
            raise StateStoreError("Committed artifact identities must be unique")
        timestamp = _text("Artifact commit timestamp", at, 128)
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
            if any(row["stage"] != artifact.owner.value for artifact in artifacts):
                raise StateTransitionError(
                    f"Artifact owner does not match work unit stage: {key}"
                )
            invalid_identities = connection.execute(
                "SELECT name, relative_path FROM artifacts "
                "WHERE job_id=? AND unit_key=? AND is_valid=0 "
                "ORDER BY name",
                (job.value, key),
            ).fetchall()
            invalid_identity_set = {
                (item["name"], item["relative_path"])
                for item in invalid_identities
            }
            submitted_identity_set = set(zip(names, paths, strict=True))
            if invalid_identity_set and invalid_identity_set != submitted_identity_set:
                raise StateStoreError(
                    "Invalidated artifact identity is ambiguous or changed"
                )
            for artifact in artifacts:
                dependencies_json = json.dumps(
                    artifact.dependencies,
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
                recommitted = connection.execute(
                    "UPDATE artifacts SET size_bytes=?, sha256=?, "
                    "dependencies_json=?, is_valid=1, committed_at=? "
                    "WHERE job_id=? AND name=? AND relative_path=? "
                    "AND owner_stage=? AND unit_key=? AND is_valid=0",
                    (
                        artifact.size_bytes,
                        artifact.sha256,
                        dependencies_json,
                        timestamp,
                        job.value,
                        artifact.name,
                        str(artifact.relative_path),
                        artifact.owner.value,
                        key,
                    ),
                )
                if recommitted.rowcount == 0:
                    connection.execute(
                        "INSERT INTO artifacts("
                        "job_id, name, relative_path, size_bytes, sha256, owner_stage, "
                        "unit_key, dependencies_json, is_valid, committed_at"
                        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
                        (
                            job.value,
                            artifact.name,
                            str(artifact.relative_path),
                            artifact.size_bytes,
                            artifact.sha256,
                            artifact.owner.value,
                            key,
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

    def _artifact_from_row(self, row: sqlite3.Row) -> Artifact:
        raw_dependencies = row["dependencies_json"]
        decoded = json.loads(raw_dependencies)
        if type(decoded) is not list or any(
            type(item) is not str
            or not item
            or item != item.strip()
            for item in decoded
        ):
            raise StateStoreError(
                "Stored artifact dependencies must be a JSON string array"
            )
        dependencies = tuple(decoded)
        canonical = json.dumps(
            dependencies,
            separators=(",", ":"),
            ensure_ascii=False,
        )
        if raw_dependencies != canonical:
            raise StateStoreError(
                "Stored artifact dependencies are not canonical JSON"
            )
        return Artifact(
            row["name"],
            PurePosixPath(row["relative_path"]),
            row["size_bytes"],
            row["sha256"],
            StageName(row["owner_stage"]),
            dependencies,
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
            return tuple(self._artifact_from_row(row) for row in rows)
        except StateStoreError:
            raise
        except (sqlite3.DatabaseError, ValueError, TypeError) as exc:
            raise StateStoreError("Unable to read valid artifacts") from exc

    def artifacts_for_unit(
        self,
        job_id: JobId,
        unit_key: str,
    ) -> tuple[Artifact, ...]:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        if self.connection is None:
            raise StateStoreError("State store is closed")
        try:
            if self.connection.execute(
                "SELECT 1 FROM work_units WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone() is None:
                raise StateStoreError(f"Work unit does not exist: {key}")
            rows = self.connection.execute(
                "SELECT name, relative_path, size_bytes, sha256, owner_stage, "
                "dependencies_json FROM artifacts "
                "WHERE job_id=? AND unit_key=? AND is_valid=1 ORDER BY name",
                (job.value, key),
            ).fetchall()
            return tuple(self._artifact_from_row(row) for row in rows)
        except StateStoreError:
            raise
        except (
            sqlite3.DatabaseError,
            DomainInvariantError,
            ValueError,
            TypeError,
        ) as exc:
            raise StateStoreError("Unable to read work-unit artifacts") from exc

    def retire_invalid_artifacts(
        self,
        job_id: JobId,
        unit_key: str,
        identities: tuple[tuple[str, PurePosixPath], ...],
    ) -> None:
        job = _job_id(job_id)
        key = _text("Work unit key", unit_key)
        if (
            type(identities) is not tuple
            or not identities
            or any(
                type(identity) is not tuple
                or len(identity) != 2
                or type(identity[0]) is not str
                or type(identity[1]) is not PurePosixPath
                for identity in identities
            )
        ):
            raise StateStoreError(
                "Retired artifact identities must be name/path pairs"
            )
        requested = tuple(
            (
                _text("Retired artifact name", name),
                str(path),
            )
            for name, path in identities
        )
        if (
            len(set(requested)) != len(requested)
            or any(
                path.startswith("/")
                or "\\" in path
                or ".." in PurePosixPath(path).parts
                for _, path in requested
            )
        ):
            raise StateStoreError(
                "Retired artifact identities must be unique safe paths"
            )
        with self._transaction() as connection:
            unit = connection.execute(
                "SELECT status FROM work_units "
                "WHERE job_id=? AND unit_key=?",
                (job.value, key),
            ).fetchone()
            if (
                unit is None
                or unit["status"] != WorkStatus.INVALID.value
            ):
                raise StateTransitionError(
                    "Artifacts can retire only from an invalid work unit"
                )
            rows = connection.execute(
                "SELECT name, relative_path FROM artifacts "
                "WHERE job_id=? AND unit_key=? AND is_valid=0",
                (job.value, key),
            ).fetchall()
            available = {
                (row["name"], row["relative_path"])
                for row in rows
            }
            if not set(requested).issubset(available):
                raise StateStoreError(
                    "Retired artifact identity is not invalid"
                )
            connection.executemany(
                "DELETE FROM artifacts WHERE job_id=? "
                "AND unit_key=? AND name=? AND relative_path=? "
                "AND is_valid=0",
                (
                    (job.value, key, name, path)
                    for name, path in requested
                ),
            )

    def invalidate_work_units(
        self,
        job_id: JobId,
        unit_keys: tuple[str, ...],
        at: str,
    ) -> tuple[str, ...]:
        job = _job_id(job_id)
        if type(unit_keys) is not tuple:
            raise StateStoreError("Invalidated work-unit keys must be a tuple")
        requested = tuple(
            _text("Invalidated work-unit key", item)
            for item in unit_keys
        )
        if tuple(sorted(set(requested))) != requested:
            raise StateStoreError(
                "Invalidated work-unit keys must be ordered and unique"
            )
        timestamp = _text("Invalidation timestamp", at, 128)
        with self._transaction() as connection:
            if connection.execute(
                "SELECT 1 FROM jobs WHERE job_id=?",
                (job.value,),
            ).fetchone() is None:
                raise StateStoreError(f"Job does not exist: {job.value}")
            rows = connection.execute(
                "SELECT unit_key, stage, status, attempts FROM work_units "
                "WHERE job_id=? ORDER BY unit_key",
                (job.value,),
            ).fetchall()
            units = tuple(
                self._unit_from_row(
                    row,
                    self._dependencies_for_unit(
                        connection,
                        job.value,
                        row["unit_key"],
                    ),
                )
                for row in rows
            )
            known = {unit.key for unit in units}
            missing = tuple(key for key in requested if key not in known)
            if missing:
                raise StateStoreError(
                    f"Work unit does not exist: {missing[0]}"
                )

            affected = set(requested)
            changed = True
            while changed:
                before = len(affected)
                affected.update(
                    unit.key
                    for unit in units
                    if any(
                        dependency in affected
                        for dependency in unit.dependencies
                    )
                )
                changed = len(affected) != before

            if not affected:
                return ()
            changed_units = tuple(
                unit
                for unit in units
                if unit.key in affected
                and unit.status is not WorkStatus.INVALID
            )
            placeholders = ",".join("?" for _ in affected)
            connection.execute(
                f"UPDATE work_units SET status=?, error_kind=NULL, "
                f"error_message=NULL, updated_at=? WHERE job_id=? "
                f"AND unit_key IN ({placeholders}) AND status<>?",
                (
                    WorkStatus.INVALID.value,
                    timestamp,
                    job.value,
                    *sorted(affected),
                    WorkStatus.INVALID.value,
                ),
            )
            connection.execute(
                f"UPDATE artifacts SET is_valid=0 WHERE job_id=? "
                f"AND unit_key IN ({placeholders}) AND is_valid=1",
                (job.value, *sorted(affected)),
            )
            stage_order = {
                stage: index
                for index, stage in enumerate(STAGE_ORDER)
            }
            return tuple(
                unit.key
                for unit in sorted(
                    changed_units,
                    key=lambda item: (
                        stage_order[item.stage],
                        item.key,
                    ),
                )
            )

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
                f"AND unit_key IN ("
                f"SELECT unit_key FROM work_units WHERE job_id=? "
                f"AND stage IN ({placeholders})"
                f") AND is_valid=1",
                (job.value, job.value, *stages),
            )
            return tuple(row["unit_key"] for row in rows)
