from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Sequence

from ytb_vps.util import now_iso


STAGES = (
    "INGEST",
    "OCR",
    "TRACK",
    "TRANSLATE",
    "TTS",
    "RENDER",
    "PUBLISH",
    "BACKUP",
    "DONE",
)


SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
    job_id TEXT PRIMARY KEY,
    input_path TEXT NOT NULL,
    source_signature TEXT NOT NULL,
    output_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    current_stage TEXT,
    media_json TEXT,
    config_signature TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS stages (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    details_json TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS chunks (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    start_frame INTEGER NOT NULL,
    end_frame INTEGER NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    artifact_path TEXT,
    checksum TEXT,
    metadata_json TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, kind, chunk_index)
);

CREATE TABLE IF NOT EXISTS detections (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    frame_index INTEGER NOT NULL,
    line_index INTEGER NOT NULL,
    xmin INTEGER NOT NULL,
    ymin INTEGER NOT NULL,
    xmax INTEGER NOT NULL,
    ymax INTEGER NOT NULL,
    text TEXT NOT NULL,
    confidence REAL,
    PRIMARY KEY (job_id, frame_index, line_index)
);
CREATE INDEX IF NOT EXISTS idx_detections_job_frame
    ON detections(job_id, frame_index);

CREATE TABLE IF NOT EXISTS cues (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    cue_index INTEGER NOT NULL,
    start_frame INTEGER NOT NULL,
    end_frame INTEGER NOT NULL,
    xmin INTEGER NOT NULL,
    ymin INTEGER NOT NULL,
    xmax INTEGER NOT NULL,
    ymax INTEGER NOT NULL,
    source_text TEXT NOT NULL,
    target_text TEXT,
    source_hash TEXT NOT NULL,
    PRIMARY KEY (job_id, cue_index)
);

CREATE TABLE IF NOT EXISTS tts_groups (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    group_index INTEGER NOT NULL,
    signature TEXT NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    raw_path TEXT,
    fitted_path TEXT,
    checksum TEXT,
    metadata_json TEXT,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, group_index)
);

CREATE TABLE IF NOT EXISTS scenes (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    scene_index INTEGER NOT NULL,
    start_frame INTEGER NOT NULL,
    end_frame INTEGER NOT NULL,
    cue_indices_json TEXT NOT NULL,
    source_text TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    xmin INTEGER NOT NULL,
    ymin INTEGER NOT NULL,
    xmax INTEGER NOT NULL,
    ymax INTEGER NOT NULL,
    summary TEXT,
    narration TEXT,
    status TEXT NOT NULL DEFAULT 'PENDING',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (job_id, scene_index)
);

CREATE TABLE IF NOT EXISTS voiceover_segments (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    scene_index INTEGER NOT NULL,
    segment_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    start_frame INTEGER NOT NULL,
    end_frame INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    audio_path TEXT,
    audio_duration_seconds REAL,
    speed REAL,
    error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, scene_index, segment_index)
);

CREATE TABLE IF NOT EXISTS artifacts (
    job_id TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    checksum TEXT NOT NULL,
    remote_path TEXT,
    remote_verified INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (job_id, name)
);

CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT REFERENCES jobs(job_id) ON DELETE CASCADE,
    stage TEXT,
    unit TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


class JobStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, timeout=30)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute("PRAGMA synchronous=FULL")
        self.connection.execute("PRAGMA busy_timeout=30000")
        self.connection.executescript(SCHEMA)
        columns = {row[1] for row in self.connection.execute("PRAGMA table_info(jobs)")}
        if "pipeline_mode" not in columns:
            self.connection.execute(
                "ALTER TABLE jobs ADD COLUMN pipeline_mode TEXT NOT NULL DEFAULT 'cue_translation'"
            )
        self.connection.commit()

    def close(self) -> None:
        self.connection.close()

    def __enter__(self) -> "JobStore":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        try:
            self.connection.execute("BEGIN IMMEDIATE")
            yield self.connection
            self.connection.commit()
        except Exception:
            self.connection.rollback()
            raise

    def initialize_job(
        self,
        *,
        job_id: str,
        input_path: Path,
        source_signature: str,
        output_path: Path,
        config_signature: str,
        pipeline_mode: str = "cue_translation",
    ) -> None:
        now = now_iso()
        with self.transaction() as db:
            existing = db.execute(
                "SELECT source_signature, config_signature, pipeline_mode FROM jobs WHERE job_id = ?",
                (job_id,),
            ).fetchone()
            if existing and existing["source_signature"] != source_signature:
                raise RuntimeError(f"Job identity collision for {job_id}")
            if existing and existing["config_signature"] != config_signature:
                db.execute(
                    "UPDATE jobs SET config_signature=?, updated_at=? WHERE job_id=?",
                    (config_signature, now, job_id),
                )
            db.execute(
                """
                INSERT INTO jobs(
                    job_id, input_path, source_signature, output_path,
                    config_signature, pipeline_mode, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(job_id) DO UPDATE SET
                    input_path=excluded.input_path,
                    output_path=excluded.output_path,
                    config_signature=excluded.config_signature,
                    updated_at=excluded.updated_at
                """,
                (
                    job_id,
                    str(input_path.resolve()),
                    source_signature,
                    str(output_path.resolve()),
                    config_signature,
                    pipeline_mode,
                    now,
                    now,
                ),
            )
            for stage in STAGES:
                db.execute(
                    """
                    INSERT OR IGNORE INTO stages(job_id, name, updated_at)
                    VALUES (?, ?, ?)
                    """,
                    (job_id, stage, now),
                )

    def recover_stale(self, job_id: str) -> None:
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                "UPDATE stages SET status='PENDING', updated_at=? "
                "WHERE job_id=? AND status='RUNNING'",
                (now, job_id),
            )
            db.execute(
                "UPDATE chunks SET status='PENDING', updated_at=? "
                "WHERE job_id=? AND status='RUNNING'",
                (now, job_id),
            )
            db.execute(
                "UPDATE tts_groups SET status='PENDING', updated_at=? "
                "WHERE job_id=? AND status='RUNNING'",
                (now, job_id),
            )
            db.execute(
                "UPDATE scenes SET status='PENDING', updated_at=? "
                "WHERE job_id=? AND status='RUNNING'",
                (now, job_id),
            )
            db.execute(
                "UPDATE voiceover_segments SET status='PENDING', updated_at=? "
                "WHERE job_id=? AND status='RUNNING'",
                (now, job_id),
            )
            db.execute(
                "UPDATE jobs SET current_stage=NULL, "
                "status=CASE WHEN status='RUNNING' THEN 'PENDING' ELSE status END, "
                "updated_at=? WHERE job_id=?",
                (now, job_id),
            )

    def job(self, job_id: str) -> dict[str, Any]:
        row = self.connection.execute(
            "SELECT * FROM jobs WHERE job_id=?", (job_id,)
        ).fetchone()
        if row is None:
            raise KeyError(job_id)
        result = dict(row)
        result["media"] = json.loads(result.pop("media_json") or "null")
        return result

    def set_media(self, job_id: str, media: dict[str, Any]) -> None:
        self.connection.execute(
            "UPDATE jobs SET media_json=?, updated_at=? WHERE job_id=?",
            (json.dumps(media, ensure_ascii=False), now_iso(), job_id),
        )
        self.connection.commit()

    def stage_status(self, job_id: str, stage: str) -> str:
        row = self.connection.execute(
            "SELECT status FROM stages WHERE job_id=? AND name=?", (job_id, stage)
        ).fetchone()
        if row is None:
            raise KeyError((job_id, stage))
        return str(row["status"])

    def start_stage(self, job_id: str, stage: str) -> None:
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                """
                UPDATE stages SET status='RUNNING', attempts=attempts+1,
                    error=NULL, started_at=?, completed_at=NULL, updated_at=?
                WHERE job_id=? AND name=?
                """,
                (now, now, job_id, stage),
            )
            db.execute(
                "UPDATE jobs SET status='RUNNING', current_stage=?, error=NULL, "
                "updated_at=? WHERE job_id=?",
                (stage, now, job_id),
            )

    def complete_stage(
        self, job_id: str, stage: str, details: dict[str, Any] | None = None
    ) -> None:
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                """
                UPDATE stages SET status='DONE', details_json=?, error=NULL,
                    completed_at=?, updated_at=? WHERE job_id=? AND name=?
                """,
                (json.dumps(details or {}, ensure_ascii=False), now, now, job_id, stage),
            )
            status = "DONE" if stage == "DONE" else "RUNNING"
            db.execute(
                "UPDATE jobs SET status=?, current_stage=NULL, updated_at=? "
                "WHERE job_id=?",
                (status, now, job_id),
            )

    def fail_stage(self, job_id: str, stage: str, error: str) -> None:
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                "UPDATE stages SET status='FAILED', error=?, updated_at=? "
                "WHERE job_id=? AND name=?",
                (error, now, job_id, stage),
            )
            db.execute(
                "UPDATE jobs SET status='FAILED', current_stage=?, error=?, "
                "updated_at=? WHERE job_id=?",
                (stage, error, now, job_id),
            )
            db.execute(
                "INSERT INTO errors(job_id, stage, message, created_at) "
                "VALUES (?, ?, ?, ?)",
                (job_id, stage, error, now),
            )

    def reset_stage(self, job_id: str, stage: str) -> None:
        self.connection.execute(
            "UPDATE stages SET status='PENDING', error=NULL, updated_at=? "
            "WHERE job_id=? AND name=?",
            (now_iso(), job_id, stage),
        )
        self.connection.commit()

    def plan_chunks(
        self,
        job_id: str,
        kind: str,
        chunks: Sequence[dict[str, int | float]],
    ) -> None:
        now = now_iso()
        with self.transaction() as db:
            for item in chunks:
                db.execute(
                    """
                    INSERT OR IGNORE INTO chunks(
                        job_id, kind, chunk_index, start_frame, end_frame,
                        start_seconds, end_seconds, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        kind,
                        int(item["index"]),
                        int(item["start_frame"]),
                        int(item["end_frame"]),
                        float(item["start_seconds"]),
                        float(item["end_seconds"]),
                        now,
                    ),
                )

    def replace_chunk_plan(
        self,
        job_id: str,
        kind: str,
        chunks: Sequence[dict[str, int | float]],
    ) -> None:
        completed = self.connection.execute(
            "SELECT COUNT(*) FROM chunks WHERE job_id=? AND kind=? AND status='DONE'",
            (job_id, kind),
        ).fetchone()[0]
        if completed:
            raise RuntimeError(f"Cannot replace {kind} plan after chunks completed")
        with self.transaction() as db:
            db.execute("DELETE FROM chunks WHERE job_id=? AND kind=?", (job_id, kind))
        self.plan_chunks(job_id, kind, chunks)

    def chunks(self, job_id: str, kind: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM chunks WHERE job_id=? AND kind=? ORDER BY chunk_index",
            (job_id, kind),
        ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            result.append(item)
        return result

    def start_chunk(self, job_id: str, kind: str, index: int) -> None:
        self.connection.execute(
            """
            UPDATE chunks SET status='RUNNING', attempts=attempts+1, error=NULL,
                updated_at=? WHERE job_id=? AND kind=? AND chunk_index=?
            """,
            (now_iso(), job_id, kind, index),
        )
        self.connection.commit()

    def complete_chunk(
        self,
        job_id: str,
        kind: str,
        index: int,
        *,
        artifact_path: Path,
        checksum: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.connection.execute(
            """
            UPDATE chunks SET status='DONE', artifact_path=?, checksum=?,
                metadata_json=?, error=NULL, updated_at=?
            WHERE job_id=? AND kind=? AND chunk_index=?
            """,
            (
                str(artifact_path.resolve()),
                checksum,
                json.dumps(metadata or {}, ensure_ascii=False),
                now_iso(),
                job_id,
                kind,
                index,
            ),
        )
        self.connection.commit()

    def fail_chunk(
        self, job_id: str, kind: str, index: int, error: str
    ) -> None:
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                "UPDATE chunks SET status='FAILED', error=?, updated_at=? "
                "WHERE job_id=? AND kind=? AND chunk_index=?",
                (error, now, job_id, kind, index),
            )
            db.execute(
                "INSERT INTO errors(job_id, stage, unit, message, created_at) "
                "VALUES (?, ?, ?, ?, ?)",
                (job_id, kind.upper(), f"{kind}:{index}", error, now),
            )

    def replace_chunk_detections(
        self,
        job_id: str,
        chunk_index: int,
        detections: Sequence[dict[str, Any]],
    ) -> None:
        with self.transaction() as db:
            db.execute(
                "DELETE FROM detections WHERE job_id=? AND chunk_index=?",
                (job_id, chunk_index),
            )
            db.executemany(
                """
                INSERT INTO detections(
                    job_id, chunk_index, frame_index, line_index,
                    xmin, ymin, xmax, ymax, text, confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        job_id,
                        chunk_index,
                        int(item["frame_index"]),
                        int(item["line_index"]),
                        int(item["box"][0]),
                        int(item["box"][1]),
                        int(item["box"][2]),
                        int(item["box"][3]),
                        str(item["text"]),
                        float(item.get("confidence", 0.0)),
                    )
                    for item in detections
                ],
            )

    def iter_detections(self, job_id: str) -> Iterator[dict[str, Any]]:
        cursor = self.connection.execute(
            "SELECT * FROM detections WHERE job_id=? "
            "ORDER BY frame_index, line_index",
            (job_id,),
        )
        for row in cursor:
            yield dict(row)

    def replace_cues(self, job_id: str, cues: Sequence[dict[str, Any]]) -> None:
        with self.transaction() as db:
            db.execute("DELETE FROM cues WHERE job_id=?", (job_id,))
            db.executemany(
                """
                INSERT INTO cues(
                    job_id, cue_index, start_frame, end_frame,
                    xmin, ymin, xmax, ymax, source_text, target_text, source_hash
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        job_id,
                        int(cue["cue_index"]),
                        int(cue["start_frame"]),
                        int(cue["end_frame"]),
                        int(cue["box"][0]),
                        int(cue["box"][1]),
                        int(cue["box"][2]),
                        int(cue["box"][3]),
                        str(cue["source_text"]),
                        cue.get("target_text"),
                        str(cue["source_hash"]),
                    )
                    for cue in cues
                ],
            )

    def cues(self, job_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM cues WHERE job_id=? ORDER BY cue_index", (job_id,)
        ).fetchall()
        return [dict(row) for row in rows]

    def set_translation(self, job_id: str, cue_index: int, text: str) -> None:
        self.connection.execute(
            "UPDATE cues SET target_text=? WHERE job_id=? AND cue_index=?",
            (text, job_id, cue_index),
        )
        self.connection.commit()

    def pipeline_mode(self, job_id: str) -> str:
        row = self.connection.execute(
            "SELECT pipeline_mode FROM jobs WHERE job_id=?", (job_id,)
        ).fetchone()
        return str(row["pipeline_mode"] if row and row["pipeline_mode"] else "cue_translation")

    def replace_scenes(self, job_id: str, scenes: Sequence[dict[str, Any]]) -> None:
        now = now_iso()
        with self.transaction() as db:
            existing = {
                int(row["scene_index"]): row
                for row in db.execute("SELECT scene_index, source_hash, status FROM scenes WHERE job_id=?", (job_id,))
            }
            for scene in scenes:
                index = int(scene["scene_index"])
                prior = existing.get(index)
                if prior and prior["source_hash"] == scene["source_hash"]:
                    continue
                db.execute("DELETE FROM scenes WHERE job_id=? AND scene_index=?", (job_id, index))
                db.execute("DELETE FROM voiceover_segments WHERE job_id=? AND scene_index=?", (job_id, index))
                db.execute(
                    """
                    INSERT INTO scenes(job_id, scene_index, start_frame, end_frame,
                        cue_indices_json, source_text, source_hash, xmin, ymin, xmax, ymax,
                        created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id, index, int(scene["start_frame"]), int(scene["end_frame"]),
                        json.dumps(scene["cue_indices"]), str(scene["source_text"]),
                        str(scene["source_hash"]), int(scene["xmin"]), int(scene["ymin"]),
                        int(scene["xmax"]), int(scene["ymax"]), now, now,
                    ),
                )
            if scenes:
                db.execute(
                    "DELETE FROM scenes WHERE job_id=? AND scene_index>=?",
                    (job_id, len(scenes)),
                )
                db.execute(
                    "DELETE FROM voiceover_segments WHERE job_id=? AND scene_index>=?",
                    (job_id, len(scenes)),
                )

    def scenes(self, job_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM scenes WHERE job_id=? ORDER BY scene_index", (job_id,)
        ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["cue_indices"] = tuple(json.loads(item.pop("cue_indices_json")))
            result.append(item)
        return result

    def start_scene(self, job_id: str, scene_index: int) -> None:
        self.connection.execute(
            "UPDATE scenes SET status='RUNNING', attempts=attempts+1, error=NULL, updated_at=? "
            "WHERE job_id=? AND scene_index=?",
            (now_iso(), job_id, scene_index),
        )
        self.connection.commit()

    def complete_scene(self, job_id: str, scene_index: int, *, summary: str, narration: str) -> None:
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                "UPDATE scenes SET summary=?, narration=?, status='DONE', error=NULL, updated_at=?, completed_at=? "
                "WHERE job_id=? AND scene_index=?",
                (summary, narration, now, now, job_id, scene_index),
            )
            scene = db.execute(
                "SELECT start_frame, end_frame FROM scenes WHERE job_id=? AND scene_index=?",
                (job_id, scene_index),
            ).fetchone()
            db.execute(
                """INSERT INTO voiceover_segments(job_id, scene_index, segment_index, text,
                    start_frame, end_frame, status, updated_at)
                    VALUES (?, ?, 0, ?, ?, ?, 'PENDING', ?)
                    ON CONFLICT(job_id, scene_index, segment_index) DO UPDATE SET
                    text=excluded.text, start_frame=excluded.start_frame, end_frame=excluded.end_frame,
                    status='PENDING', audio_path=NULL, audio_duration_seconds=NULL, speed=NULL,
                    error=NULL, updated_at=excluded.updated_at""",
                (job_id, scene_index, narration, int(scene["start_frame"]), int(scene["end_frame"]), now),
            )

    def skip_scene(self, job_id: str, scene_index: int, error: str) -> None:
        self.connection.execute(
            "UPDATE scenes SET status='SKIPPED', error=?, updated_at=?, completed_at=? "
            "WHERE job_id=? AND scene_index=?",
            (error, now_iso(), now_iso(), job_id, scene_index),
        )
        self.connection.execute(
            "UPDATE voiceover_segments SET status='SKIPPED', error=?, updated_at=? "
            "WHERE job_id=? AND scene_index=?",
            (error, now_iso(), job_id, scene_index),
        )
        self.connection.commit()

    def voiceover_segments(self, job_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM voiceover_segments WHERE job_id=? ORDER BY scene_index, segment_index",
            (job_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def complete_voiceover_segment(
        self, job_id: str, scene_index: int, *, fitted_path: Path, duration_seconds: float, speed: float, fps: int
    ) -> None:
        self.connection.execute(
            "UPDATE voiceover_segments SET end_frame=start_frame + CAST(? AS INTEGER), status='DONE', "
            "audio_path=?, audio_duration_seconds=?, speed=?, error=NULL, updated_at=? "
            "WHERE job_id=? AND scene_index=? AND segment_index=0",
            (round(duration_seconds * fps), str(fitted_path.resolve()), duration_seconds, speed, now_iso(), job_id, scene_index),
        )
        self.connection.commit()

    def skip_voiceover_segment(self, job_id: str, scene_index: int, error: str) -> None:
        self.connection.execute(
            "UPDATE voiceover_segments SET status='SKIPPED', error=?, updated_at=? "
            "WHERE job_id=? AND scene_index=?",
            (error, now_iso(), job_id, scene_index),
        )
        self.connection.commit()

    def invalidate_tts_fit_version(self, job_id: str, fit_version: int) -> int:
        rows = self.connection.execute(
            "SELECT group_index, metadata_json FROM tts_groups "
            "WHERE job_id=? AND status='DONE'",
            (job_id,),
        ).fetchall()
        stale = []
        for row in rows:
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except json.JSONDecodeError:
                metadata = {}
            if int(metadata.get("fit_algorithm_version", 0)) != int(fit_version):
                stale.append(int(row["group_index"]))
        if not stale:
            return 0
        placeholders = ",".join("?" for _ in stale)
        now = now_iso()
        with self.transaction() as db:
            db.execute(
                f"UPDATE tts_groups SET status='PENDING', fitted_path=NULL, checksum=NULL, "
                f"metadata_json=NULL, error=NULL, updated_at=? WHERE job_id=? "
                f"AND group_index IN ({placeholders})",
                (now, job_id, *stale),
            )
            db.execute(
                "UPDATE chunks SET status='PENDING', artifact_path=NULL, checksum=NULL, "
                "metadata_json=NULL, error=NULL, updated_at=? "
                "WHERE job_id=? AND kind='render'",
                (now, job_id),
            )
            db.execute(
                "UPDATE stages SET status='PENDING', details_json=NULL, error=NULL, "
                "started_at=NULL, completed_at=NULL, updated_at=? "
                "WHERE job_id=? AND name IN ('RENDER','PUBLISH','BACKUP','DONE')",
                (now, job_id),
            )
        return len(stale)

    def replan_tts_group(self, job_id: str, group, config: dict[str, Any]) -> None:
        self.connection.execute(
            "UPDATE tts_groups SET signature=?, start_seconds=?, end_seconds=?, text=?, "
            "status='PENDING', raw_path=NULL, fitted_path=NULL, checksum=NULL, "
            "metadata_json=NULL, error=NULL, updated_at=? "
            "WHERE job_id=? AND group_index=?",
            (
                group.signature(config),
                group.start,
                group.end,
                group.text,
                now_iso(),
                job_id,
                group.index,
            ),
        )
        self.connection.commit()

    def plan_tts_groups(self, job_id: str, groups, config: dict[str, Any]) -> None:
        from ytb_vps.util import now_iso

        now = now_iso()
        with self.transaction() as db:
            for group in groups:
                signature = group.signature(config)
                existing = db.execute(
                    "SELECT signature, start_seconds, end_seconds, status, metadata_json "
                    "FROM tts_groups WHERE job_id=? AND group_index=?",
                    (job_id, group.index),
                ).fetchone()
                if existing and existing["signature"] != signature:
                    try:
                        metadata = json.loads(existing["metadata_json"] or "{}")
                    except json.JSONDecodeError:
                        metadata = {}
                    preserve_text_override = (
                        metadata.get("tts_text_override") is True
                        and metadata.get("base_signature") == signature
                        and abs(float(existing["start_seconds"]) - float(group.start)) < 0.001
                        and abs(float(existing["end_seconds"]) - float(group.end)) < 0.001
                    )
                    if not preserve_text_override:
                        db.execute(
                            "DELETE FROM tts_groups WHERE job_id=? AND group_index=?",
                            (job_id, group.index),
                        )
                db.execute(
                    """
                    INSERT OR IGNORE INTO tts_groups(
                        job_id, group_index, signature, start_seconds,
                        end_seconds, text, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        job_id,
                        group.index,
                        signature,
                        group.start,
                        group.end,
                        group.text,
                        now,
                    ),
                )
            db.execute(
                "DELETE FROM tts_groups WHERE job_id=? AND group_index>=?",
                (job_id, len(groups)),
            )

    def tts_groups(self, job_id: str) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT * FROM tts_groups WHERE job_id=? ORDER BY group_index", (job_id,)
        ).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            result.append(item)
        return result

    def start_tts_group(self, job_id: str, index: int) -> None:
        self.connection.execute(
            "UPDATE tts_groups SET status='RUNNING', attempts=attempts+1, "
            "error=NULL, updated_at=? WHERE job_id=? AND group_index=?",
            (now_iso(), job_id, index),
        )
        self.connection.commit()

    def complete_tts_group(
        self,
        job_id: str,
        index: int,
        *,
        raw: Path,
        fitted: Path,
        checksum: str,
        metadata: dict[str, Any],
    ) -> None:
        self.connection.execute(
            """
            UPDATE tts_groups SET status='DONE', raw_path=?, fitted_path=?,
                checksum=?, metadata_json=?, error=NULL, updated_at=?
            WHERE job_id=? AND group_index=?
            """,
            (
                str(raw.resolve()),
                str(fitted.resolve()),
                checksum,
                json.dumps(metadata, ensure_ascii=False),
                now_iso(),
                job_id,
                index,
            ),
        )
        self.connection.commit()

    def fail_tts_group(self, job_id: str, index: int, error: str) -> None:
        self.connection.execute(
            "UPDATE tts_groups SET status='FAILED', error=?, updated_at=? "
            "WHERE job_id=? AND group_index=?",
            (error, now_iso(), job_id, index),
        )
        self.connection.commit()

    def record_artifact(
        self,
        job_id: str,
        name: str,
        path: Path,
        checksum: str,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.connection.execute(
            """
            INSERT INTO artifacts(
                job_id, name, path, size_bytes, checksum, metadata_json, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(job_id, name) DO UPDATE SET
                path=excluded.path, size_bytes=excluded.size_bytes,
                checksum=excluded.checksum, metadata_json=excluded.metadata_json,
                remote_verified=0, updated_at=excluded.updated_at
            """,
            (
                job_id,
                name,
                str(path.resolve()),
                path.stat().st_size,
                checksum,
                json.dumps(metadata or {}, ensure_ascii=False),
                now_iso(),
            ),
        )
        self.connection.commit()

    def mark_artifact_remote(
        self, job_id: str, name: str, remote_path: str
    ) -> None:
        self.connection.execute(
            "UPDATE artifacts SET remote_path=?, remote_verified=1, updated_at=? "
            "WHERE job_id=? AND name=?",
            (remote_path, now_iso(), job_id, name),
        )
        self.connection.commit()

    def artifacts(self, job_id: str) -> list[dict[str, Any]]:
        result = []
        for row in self.connection.execute(
            "SELECT * FROM artifacts WHERE job_id=? ORDER BY name", (job_id,)
        ).fetchall():
            item = dict(row)
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            result.append(item)
        return result

    def mark_render_chunks_published(
        self,
        job_id: str,
        chunks: list[dict[str, Any]],
        *,
        remote_path: str,
    ) -> None:
        """Keep a render checkpoint valid after its verified final Part is removed."""
        with self.transaction() as db:
            for chunk in chunks:
                metadata = dict(chunk.get("metadata") or {})
                metadata["published_remote"] = remote_path
                db.execute(
                    "UPDATE chunks SET metadata_json=?, updated_at=? "
                    "WHERE job_id=? AND kind='render' AND chunk_index=?",
                    (
                        json.dumps(metadata, ensure_ascii=False),
                        now_iso(),
                        job_id,
                        int(chunk["chunk_index"]),
                    ),
                )

    def summary(self, job_id: str) -> dict[str, Any]:
        stages = [
            dict(row)
            for row in self.connection.execute(
                "SELECT name, status, attempts, error, updated_at FROM stages "
                "WHERE job_id=? ORDER BY rowid",
                (job_id,),
            ).fetchall()
        ]
        chunks = {
            row["kind"]: {row["status"]: row["count"] for row in rows}
            for row in self.connection.execute(
                "SELECT DISTINCT kind FROM chunks WHERE job_id=?", (job_id,)
            ).fetchall()
            for rows in [[
                dict(item)
                for item in self.connection.execute(
                    "SELECT status, COUNT(*) AS count FROM chunks "
                    "WHERE job_id=? AND kind=? GROUP BY status",
                    (job_id, row["kind"]),
                ).fetchall()
            ]]
        }
        return {"job": self.job(job_id), "stages": stages, "chunks": chunks}
