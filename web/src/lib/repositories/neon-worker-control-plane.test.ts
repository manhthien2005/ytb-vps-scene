// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkerControlPlaneRepository } from "./neon-worker-control-plane";
import type { WorkerCapabilities, WorkerDoctorReport } from "@/lib/domain/worker";

const NOW = new Date("2026-07-20T08:30:00.000Z");
const BEFORE_EXPIRY = new Date("2026-07-20T08:31:00.000Z");
const AFTER_EXPIRY = new Date("2026-07-20T08:32:00.000Z");
const capabilities: WorkerCapabilities = {
  protocolVersion: 1,
  pipelineBridgeVersion: "bridge-v1",
  os: "ubuntu-22.04",
  arch: "x86_64",
  gpuName: "NVIDIA GeForce RTX 3060",
  vramMiB: 12_288,
  cudaVersion: "12.4",
  nvenc: true,
};
const doctor: WorkerDoctorReport = {
  status: "PASS",
  reasonCodes: ["CUDA_AVAILABLE", "NVENC_AVAILABLE"],
  observedAt: NOW.toISOString(),
};

describe("worker control plane repository", () => {
  let db: PGlite;
  let repository: ReturnType<typeof createWorkerControlPlaneRepository>;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
    repository = createWorkerControlPlaneRepository({
      query: (text, parameters) => db.query(text, parameters),
    });
  });

  afterEach(async () => db.close());

  it("installs multipart OUTPUT identity migration v12", async () => {
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name='artifacts'
         and column_name in ('part_index','part_count')
       order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: "part_count" },
      { column_name: "part_index" },
    ]);
    const indexes = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname,indexdef from pg_indexes
       where tablename='artifacts' and indexname like '%live_output%'
       order by indexname`,
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toContain(
      "(job_id, part_index)",
    );
    await expect(
      db.query(
        "select version from schema_migrations where version=12",
      ),
    ).resolves.toMatchObject({ rows: [{ version: 12 }] });
  });

  it("installs the serialized output-plan guard migration v13", async () => {
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name='jobs' and column_name='output_part_count'`,
    );
    expect(columns.rows).toEqual([
      { column_name: "output_part_count" },
    ]);
    await expect(
      db.query(
        "select version from schema_migrations where version=13",
      ),
    ).resolves.toMatchObject({ rows: [{ version: 13 }] });
  });

  async function enrollWorker(suffix: string) {
    const tokenDigest = suffix.repeat(64).slice(0, 64);
    const sessionDigest = (suffix === "a" ? "c" : "d").repeat(64);
    const workerId = `10000000-0000-4000-8000-00000000000${suffix === "a" ? "1" : "2"}`;
    await repository.createEnrollment({
      tokenDigest,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
    });
    const result = await repository.enrollWorker({
      tokenDigest,
      workerId,
      sessionDigest,
      sessionExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      accountLabel: null,
      capabilities,
      doctor,
      state: "READY",
      now: NOW,
    });
    expect(result?.outcome).toBe("ENROLLED");
    return result!.worker;
  }

  async function seedSourceReadyProject() {
    const projectId = "20000000-0000-4000-8000-000000000001";
    await db.query(
      `insert into projects(
         id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash,
         drive_project_folder_id,drive_input_folder_id
       ) values ($1,'READY','Video test','SOURCE_READY',$2,$3,'drive-project-001','drive-input-0001')`,
      [projectId, "e".repeat(64), "f".repeat(64)],
    );
    await db.query(
      `insert into artifacts(
         id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,
         expected_size_bytes,actual_size_bytes,checksum_sha256,verified_at
       ) values ($1,$2,'SOURCE','READY','drive-source-001','drive-input-0001','source.mp4',
         'video/mp4',100,100,$3,$4)`,
      ["30000000-0000-4000-8000-000000000001", projectId, "a".repeat(64), NOW.toISOString()],
    );
    await db.query(
      `insert into project_scene_settings(project_id,settings,updated_at)
       values ($1,$2::jsonb,$3)`,
      [projectId, JSON.stringify({
        sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
        logo: { x: 0.8, y: 0.05, width: 0.15, height: 0.1 },
        voice: "BV074_streaming",
        rate: 1,
      }), NOW.toISOString()],
    );
    return projectId;
  }

  it("consumes one enrollment token exactly once under concurrency", async () => {
    const tokenDigest = "a".repeat(64);
    await repository.createEnrollment({
      tokenDigest,
      expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      now: NOW,
    });
    const input = {
      tokenDigest,
      workerId: "10000000-0000-4000-8000-000000000001",
      sessionDigest: "c".repeat(64),
      sessionExpiresAt: new Date(NOW.getTime() + 24 * 60 * 60_000),
      accountLabel: null,
      capabilities,
      doctor,
      state: "READY" as const,
      now: NOW,
    };
    const [first, second] = await Promise.all([
      repository.enrollWorker(input),
      repository.enrollWorker({ ...input, workerId: "10000000-0000-4000-8000-000000000002", sessionDigest: "d".repeat(64) }),
    ]);
    expect([first, second].filter((value) => value?.outcome === "ENROLLED")).toHaveLength(1);
  });

  it("authenticates only a live session and parses database JSON fail-closed", async () => {
    const worker = await enrollWorker("a");
    await expect(repository.authenticateWorker("c".repeat(64), NOW)).resolves.toEqual(worker);
    await expect(repository.authenticateWorker("c".repeat(64), new Date("2026-07-22T00:00:00.000Z")))
      .resolves.toBeNull();
    await db.query("update workers set capabilities='{}'::jsonb where id=$1", [worker.id]);
    await expect(repository.listWorkers(NOW)).rejects.toThrow();
  });

  it("queues only a source-ready project and keeps request retries idempotent", async () => {
    const projectId = await seedSourceReadyProject();
    const input = {
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "1".repeat(64),
      now: NOW,
    };
    const first = await repository.queueProjectJob(input);
    const second = await repository.queueProjectJob({ ...input, jobId: "40000000-0000-4000-8000-000000000002" });
    expect(second).toEqual(first);
    expect(first).toMatchObject({ state: "QUEUED", projectName: "Video test" });
  });

  it("captures immutable settings and source metadata snapshots for claims", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "3".repeat(64),
      now: NOW,
    });
    expect(job).toMatchObject({
      settingsSnapshot: {
        version: 1,
        voice: "BV074_streaming",
        rate: 1,
      },
      sourceMetadata: {
        artifactId: "30000000-0000-4000-8000-000000000001",
        displayName: "source.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
        checksumSha256: "a".repeat(64),
      },
    });

    await db.query(
      `update project_scene_settings
       set settings=$2::jsonb,updated_at=$3
       where project_id=$1`,
      [projectId, JSON.stringify({
        sourceSubtitle: { x: 0.2, y: 0.2, width: 0.5, height: 0.2 },
        logo: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        voice: "BV074_streaming",
        rate: 0.8,
      }), BEFORE_EXPIRY.toISOString()],
    );

    const assignment = await repository.claimJob(worker.id, NOW, "bridge-v1");
    expect(assignment?.execution.sceneSettings).toMatchObject({
      version: 1,
      sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
      logo: { x: 0.8, y: 0.05, width: 0.15, height: 0.1 },
      rate: 1,
    });
  });

  it("returns the safe not-queueable result for malformed settings", async () => {
    const projectId = await seedSourceReadyProject();
    await db.query(
      `update project_scene_settings set settings=$2::jsonb where project_id=$1`,
      [projectId, JSON.stringify({ malformed: true })],
    );

    await expect(repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "6".repeat(64),
      now: NOW,
    })).resolves.toBeNull();
  });

  it("falls back to current project settings for legacy queued jobs", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    await db.query(
      `insert into jobs(
         id,project_id,project_name,state,progress_percent,request_key_digest,created_at,updated_at
       ) values ($1,$2,'Legacy video','QUEUED',0,$3,$4,$4)`,
      [
        "40000000-0000-4000-8000-000000000001",
        projectId,
        "7".repeat(64),
        NOW.toISOString(),
      ],
    );

    const assignment = await repository.claimJob(worker.id, NOW, "bridge-v1");
    expect(assignment?.execution.sceneSettings).toMatchObject({
      version: 1,
      sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
      rate: 1,
    });
  });

  it("persists bounded telemetry/history and rejects progress regressions", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "4".repeat(64),
      now: NOW,
    });
    await repository.claimJob(worker.id, NOW, "bridge-v1");

    await expect(repository.updateJobProgress({
      workerId: worker.id,
      jobId: job!.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 20,
      phase: "download",
      phaseProgressPercent: 50,
      message: "Downloading source",
      etaSeconds: 120,
      processedSeconds: 10,
      totalSeconds: 100,
      currentPart: 1,
      totalParts: 2,
      errorCode: null,
      now: BEFORE_EXPIRY,
    })).resolves.toBe("UPDATED");

    const telemetry = await db.query(
      `select state,progress_percent,active_phase,phase_progress_percent,latest_message,eta_seconds
       from jobs where id=$1`,
      [job!.id],
    );
    expect(telemetry.rows[0]).toMatchObject({
      state: "DOWNLOADING",
      progress_percent: 20,
      active_phase: "download",
      phase_progress_percent: 50,
      latest_message: "Downloading source",
      eta_seconds: 120,
    });
    const history = await db.query(
      `select phase,progress_percent,message from job_progress_history where job_id=$1`,
      [job!.id],
    );
    expect(history.rows).toEqual([
      { phase: "download", progress_percent: 20, message: "Downloading source" },
    ]);

    await expect(repository.updateJobProgress({
      workerId: worker.id,
      jobId: job!.id,
      fencingToken: 1,
      fromState: "DOWNLOADING",
      state: "OCR",
      progressPercent: 30,
      etaSeconds: -1,
      now: BEFORE_EXPIRY,
    })).rejects.toThrow("Invalid ETA");
    await expect(repository.updateJobProgress({
      workerId: worker.id,
      jobId: job!.id,
      fencingToken: 1,
      fromState: "DOWNLOADING",
      state: "COMPLETED",
      progressPercent: 100,
      now: BEFORE_EXPIRY,
    })).rejects.toThrow("Illegal job transition");

    await expect(repository.updateJobProgress({
      workerId: worker.id,
      jobId: job!.id,
      fencingToken: 1,
      fromState: "DOWNLOADING",
      state: "OCR",
      progressPercent: 10,
      now: AFTER_EXPIRY,
    })).resolves.toBe("LEASE_LOST");
    const unchanged = await db.query(
      `select state,progress_percent from jobs where id=$1`,
      [job!.id],
    );
    expect(unchanged.rows[0]).toMatchObject({ state: "DOWNLOADING", progress_percent: 20 });
  });

  it("exposes cooperative cancellation through lease renewal", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "5".repeat(64),
      now: NOW,
    });
    await repository.claimJob(worker.id, NOW, "bridge-v1");
    await db.query(
      `update jobs set cancel_requested_at=$2 where id=$1`,
      [job!.id, BEFORE_EXPIRY.toISOString()],
    );

    await expect(repository.renewLease({
      workerId: worker.id,
      jobId: job!.id,
      fencingToken: 1,
      now: BEFORE_EXPIRY,
    })).resolves.toMatchObject({ cancelRequested: true, fencingToken: 1 });
  });

  it("restarts progress under the new fence and rejects stale progress after lease takeover", async () => {
    const workerA = await enrollWorker("a");
    const workerB = await enrollWorker("b");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "1".repeat(64),
      now: NOW,
    });
    expect(job).not.toBeNull();

    const first = await repository.claimJob(workerA.id, NOW, "bridge-v1");
    expect(first?.job.progressPercent).toBe(0);
    await expect(repository.updateJobProgress({
      workerId: workerA.id,
      jobId: job!.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 20,
      now: BEFORE_EXPIRY,
    })).resolves.toBe("UPDATED");
    const progressed = await db.query("select state,progress_percent from jobs where id=$1", [job!.id]);
    expect(progressed.rows[0]).toMatchObject({ state: "DOWNLOADING", progress_percent: 20 });

    const second = await repository.claimJob(workerB.id, AFTER_EXPIRY, "bridge-v1");
    expect(first?.lease.fencingToken).toBe(1);
    expect(first?.execution).toEqual({
      projectId,
      source: {
        driveFileId: "drive-source-001",
        fileName: "source.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
        sha256: "a".repeat(64),
      },
      outputParentId: "drive-project-001",
      sceneSettings: {
        version: 1,
        sourceArtifactId: null,
        sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
        logo: { x: 0.8, y: 0.05, width: 0.15, height: 0.1 },
        voice: "BV074_streaming",
        rate: 1,
      },
    });
    expect(second?.lease.fencingToken).toBe(2);
    expect(second?.job).toMatchObject({ state: "CLAIMED", progressPercent: 0 });
    await expect(repository.updateJobProgress({
      workerId: workerB.id,
      jobId: job!.id,
      fencingToken: 2,
      fromState: "CLAIMED",
      state: "DOWNLOADING",
      progressPercent: 5,
      now: AFTER_EXPIRY,
    })).resolves.toBe("UPDATED");
    await expect(repository.updateJobProgress({
      workerId: workerA.id,
      jobId: job!.id,
      fencingToken: 1,
      fromState: "DOWNLOADING",
      state: "OCR",
      progressPercent: 20,
      now: AFTER_EXPIRY,
    })).resolves.toBe("LEASE_LOST");
  });

  it("does not assign work to a bridge-incompatible worker", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "1".repeat(64),
      now: NOW,
    });
    await expect(repository.claimJob(worker.id, NOW, "bridge-v2")).resolves.toBeNull();
  });

  it("reserves and completes an exact multipart set under one fence", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "2".repeat(64),
      now: NOW,
    });
    const assignment = await repository.claimJob(worker.id, NOW, "bridge-v1");
    expect(job).not.toBeNull();
    expect(assignment).not.toBeNull();
    await expect(repository.getFencedExecution(worker.id, job!.id, 1, NOW))
      .resolves.toEqual(assignment!.execution);
    await db.query(
      "update jobs set state='UPLOADING' where id=$1",
      [job!.id],
    );

    const reservation = {
      artifactId: "50000000-0000-4000-8000-000000000001",
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: "drive-output-001",
      driveParentId: "drive-project-001",
      partIndex: 1,
      partCount: 2,
      sizeBytes: 1234,
      checksumSha256: "a".repeat(64),
      now: NOW,
    };
    await expect(repository.reserveOutput(reservation)).resolves.toBe("RESERVED");
    await expect(repository.reserveOutput(reservation)).resolves.toBe("PENDING_REPLAY");
    await expect(repository.completeOutput({
      artifactId: reservation.artifactId,
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: "drive-output-001",
      partIndex: 1,
      partCount: 2,
      sizeBytes: 1234,
      now: NOW,
    })).resolves.toBe("PART_COMPLETED");
    await expect(repository.reserveOutput(reservation)).resolves.toBe("READY_REPLAY");
    await expect(repository.reserveOutput({
      ...reservation,
      artifactId: "50000000-0000-4000-8000-000000000099",
      driveFileId: "drive-output-changed",
      checksumSha256: "f".repeat(64),
    })).resolves.toBe("LEASE_LOST");

    const intermediateJob = await db.query(
      "select state from jobs where id=$1",
      [job!.id],
    );
    expect(intermediateJob.rows[0]).not.toMatchObject({
      state: "COMPLETED",
    });
    const intermediateWorker = await db.query(
      "select state from workers where id=$1",
      [worker.id],
    );
    expect(intermediateWorker.rows[0]).toMatchObject({ state: "BUSY" });
    const intermediateAttempts = await db.query(
      "select ended_at from job_attempts where job_id=$1 and worker_id=$2",
      [job!.id, worker.id],
    );
    expect(intermediateAttempts.rows).toEqual([{ ended_at: null }]);
    const intermediateLeases = await db.query(
      "select fencing_token from job_leases where job_id=$1 and worker_id=$2",
      [job!.id, worker.id],
    );
    expect(intermediateLeases.rows).toEqual([{ fencing_token: 1 }]);
    await expect(repository.reserveOutput({
      ...reservation,
      artifactId: "50000000-0000-4000-8000-000000000002",
      driveFileId: "drive-output-002",
      partIndex: 2,
      partCount: 3,
    })).resolves.toBe("LEASE_LOST");

    const second = {
      ...reservation,
      artifactId: "50000000-0000-4000-8000-000000000002",
      driveFileId: "drive-output-002",
      partIndex: 2,
    };
    await expect(repository.reserveOutput(second)).resolves.toBe("RESERVED");
    await expect(repository.completeOutput({
      artifactId: second.artifactId,
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: second.driveFileId,
      partIndex: 2,
      partCount: 2,
      sizeBytes: 1234,
      now: NOW,
    })).resolves.toBe("COMPLETED");
    await expect(repository.completeOutput({
      artifactId: second.artifactId,
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: second.driveFileId,
      partIndex: 2,
      partCount: 2,
      sizeBytes: 1234,
      now: NOW,
    })).resolves.toBe("REPLAY");

    await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
    const preservedParts = await db.query(
      `select part_index,part_count,status
       from artifacts
       where job_id=$1 and kind='OUTPUT'
       order by part_index`,
      [job!.id],
    );
    expect(preservedParts.rows).toEqual([
      { part_index: 1, part_count: 2, status: "READY" },
      { part_index: 2, part_count: 2, status: "READY" },
    ]);
  });

  it("serializes conflicting multipart totals on the job row", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "b".repeat(64),
      now: NOW,
    });
    await repository.claimJob(worker.id, NOW, "bridge-v1");
    await db.query(
      "update jobs set state='UPLOADING' where id=$1",
      [job!.id],
    );
    const base = {
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveParentId: "drive-project-001",
      partIndex: 1,
      sizeBytes: 1234,
      now: BEFORE_EXPIRY,
    };

    const outcomes = await Promise.all([
      repository.reserveOutput({
        ...base,
        artifactId: "50000000-0000-4000-8000-000000000001",
        driveFileId: "drive-output-two-parts",
        partCount: 2,
        checksumSha256: "b".repeat(64),
      }),
      repository.reserveOutput({
        ...base,
        artifactId: "50000000-0000-4000-8000-000000000002",
        driveFileId: "drive-output-three-parts",
        partCount: 3,
        checksumSha256: "c".repeat(64),
      }),
    ]);

    expect([...outcomes].sort()).toEqual([
      "LEASE_LOST",
      "RESERVED",
    ]);
    const stored = await db.query<{
      output_part_count: number;
      artifact_part_count: number;
    }>(
      `select j.output_part_count,
              min(a.part_count)::integer as artifact_part_count
       from jobs j
       join artifacts a on a.job_id=j.id
         and a.kind='OUTPUT' and a.status<>'DELETED'
       where j.id=$1
       group by j.output_part_count`,
      [job!.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.artifact_part_count)
      .toBe(stored.rows[0]?.output_part_count);
  });

  it("rejects stale reserve and completion after lease takeover", async () => {
    const workerA = await enrollWorker("a");
    const workerB = await enrollWorker("b");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "c".repeat(64),
      now: NOW,
    });
    await repository.claimJob(workerA.id, NOW, "bridge-v1");
    await db.query(
      "update jobs set state='UPLOADING' where id=$1",
      [job!.id],
    );
    const stale = {
      artifactId: "50000000-0000-4000-8000-000000000001",
      jobId: job!.id,
      workerId: workerA.id,
      fencingToken: 1,
      driveFileId: "drive-output-stale",
      driveParentId: "drive-project-001",
      partIndex: 1,
      partCount: 2,
      sizeBytes: 1234,
      checksumSha256: "d".repeat(64),
      now: BEFORE_EXPIRY,
    };
    await expect(repository.reserveOutput(stale))
      .resolves.toBe("RESERVED");

    const takeover = await repository.claimJob(
      workerB.id,
      AFTER_EXPIRY,
      "bridge-v1",
    );
    expect(takeover?.lease.fencingToken).toBe(2);
    await db.query(
      "update jobs set state='UPLOADING' where id=$1",
      [job!.id],
    );
    await expect(repository.reserveOutput({
      ...stale,
      artifactId: "50000000-0000-4000-8000-000000000003",
      driveFileId: "drive-output-stale-part-two",
      partIndex: 2,
      now: AFTER_EXPIRY,
    })).resolves.toBe("LEASE_LOST");
    await expect(repository.completeOutput({
      artifactId: stale.artifactId,
      jobId: job!.id,
      workerId: workerA.id,
      fencingToken: 1,
      driveFileId: stale.driveFileId,
      partIndex: 1,
      partCount: 2,
      sizeBytes: 1234,
      now: AFTER_EXPIRY,
    })).resolves.toBe("LEASE_LOST");

    const replacement = {
      ...stale,
      artifactId: "50000000-0000-4000-8000-000000000002",
      workerId: workerB.id,
      fencingToken: 2,
      driveFileId: "drive-output-current",
      checksumSha256: "e".repeat(64),
      now: AFTER_EXPIRY,
    };
    await expect(repository.reserveOutput(replacement))
      .resolves.toBe("RESERVED");
    await expect(repository.completeOutput({
      artifactId: replacement.artifactId,
      jobId: job!.id,
      workerId: workerB.id,
      fencingToken: 2,
      driveFileId: replacement.driveFileId,
      partIndex: 1,
      partCount: 2,
      sizeBytes: 1234,
      now: AFTER_EXPIRY,
    })).resolves.toBe("PART_COMPLETED");
  });

  it("never claims a job whose READY source is gone, leaving no orphaned lease", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "6".repeat(64),
      now: NOW,
    });
    await db.query("update artifacts set status='DELETED' where kind='SOURCE' and project_id=$1", [projectId]);

    await expect(repository.claimJob(worker.id, NOW, "bridge-v1")).resolves.toBeNull();

    // The claim must not half-commit: no lease, no attempt, job still QUEUED, worker READY.
    const leases = await db.query("select job_id from job_leases where job_id=$1", [job!.id]);
    expect(leases.rows).toHaveLength(0);
    const attempts = await db.query("select id from job_attempts where job_id=$1", [job!.id]);
    expect(attempts.rows).toHaveLength(0);
    const stored = await db.query("select state from jobs where id=$1", [job!.id]);
    expect(stored.rows[0]).toMatchObject({ state: "QUEUED" });
    const storedWorker = await db.query("select state from workers where id=$1", [worker.id]);
    expect(storedWorker.rows[0]).toMatchObject({ state: "READY" });
  });

  it("closes the attempt, releases the lease, and frees the worker on a terminal failure report", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "7".repeat(64),
      now: NOW,
    });
    await repository.claimJob(worker.id, NOW, "bridge-v1");
    await expect(repository.updateJobProgress({
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      fromState: "CLAIMED",
      state: "FAILED_FINAL",
      progressPercent: 5,
      errorCode: "PIPELINE_CRASHED",
      now: BEFORE_EXPIRY,
    })).resolves.toBe("UPDATED");

    const attempt = await db.query<{ outcome: string; ended_at: string }>(
      "select outcome,ended_at from job_attempts where job_id=$1",
      [job!.id],
    );
    expect(attempt.rows[0]?.outcome).toBe("FAILED");
    expect(attempt.rows[0]?.ended_at).not.toBeNull();
    const leases = await db.query("select job_id from job_leases where job_id=$1", [job!.id]);
    expect(leases.rows).toHaveLength(0);
    const storedWorker = await db.query("select state from workers where id=$1", [worker.id]);
    expect(storedWorker.rows[0]).toMatchObject({ state: "READY" });
  });

  it("supersedes a stale PENDING output from a crashed attempt instead of wedging the job", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "8".repeat(64),
      now: NOW,
    });
    await repository.claimJob(worker.id, NOW, "bridge-v1");
    await db.query(
      "update jobs set state='UPLOADING' where id=$1",
      [job!.id],
    );
    const staleReservation = {
      artifactId: "50000000-0000-4000-8000-000000000001",
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: "drive-output-001",
      driveParentId: "drive-project-001",
      partIndex: 1,
      partCount: 2,
      sizeBytes: 1234,
      checksumSha256: "b".repeat(64),
      now: NOW,
    };
    await expect(repository.reserveOutput(staleReservation)).resolves.toBe("RESERVED");
    await expect(repository.reserveOutput({
      ...staleReservation,
      artifactId: "50000000-0000-4000-8000-000000000003",
      driveFileId: "drive-output-002",
      partIndex: 2,
    })).resolves.toBe("RESERVED");

    // Retry after a crash re-renders the video: new checksum, new content-derived id.
    await expect(repository.reserveOutput({
      ...staleReservation,
      artifactId: "50000000-0000-4000-8000-000000000002",
      checksumSha256: "c".repeat(64),
      now: BEFORE_EXPIRY,
    })).resolves.toBe("RESERVED");

    const artifacts = await db.query(
      "select id,status from artifacts where job_id=$1 and kind='OUTPUT' order by id",
      [job!.id],
    );
    expect(artifacts.rows).toEqual([
      { id: "50000000-0000-4000-8000-000000000001", status: "DELETED" },
      { id: "50000000-0000-4000-8000-000000000002", status: "PENDING" },
      { id: "50000000-0000-4000-8000-000000000003", status: "PENDING" },
    ]);

    await expect(repository.reserveOutput(staleReservation))
      .resolves.toBe("RESERVED");
    const returnedToOriginal = await db.query(
      "select id,status from artifacts where job_id=$1 and kind='OUTPUT' order by id",
      [job!.id],
    );
    expect(returnedToOriginal.rows).toEqual([
      { id: "50000000-0000-4000-8000-000000000001", status: "PENDING" },
      { id: "50000000-0000-4000-8000-000000000002", status: "DELETED" },
      { id: "50000000-0000-4000-8000-000000000003", status: "PENDING" },
    ]);
  });

  it("finalizes a CANCEL_REQUESTED job whose lease expired during the recovery sweep", async () => {
    const worker = await enrollWorker("a");
    const projectId = await seedSourceReadyProject();
    const job = await repository.queueProjectJob({
      jobId: "40000000-0000-4000-8000-000000000001",
      projectId,
      requestKeyDigest: "9".repeat(64),
      now: NOW,
    });
    await repository.claimJob(worker.id, NOW, "bridge-v1");
    await db.query(
      "update jobs set state='CANCEL_REQUESTED',cancel_requested_at=$2 where id=$1",
      [job!.id, BEFORE_EXPIRY.toISOString()],
    );

    await repository.expireWorkersAndLeases(AFTER_EXPIRY);

    const stored = await db.query<{ state: string; completed_at: string }>(
      "select state,completed_at from jobs where id=$1",
      [job!.id],
    );
    expect(stored.rows[0]?.state).toBe("CANCELLED");
    expect(stored.rows[0]?.completed_at).not.toBeNull();
    const attempt = await db.query<{ outcome: string; ended_at: string }>(
      "select outcome,ended_at from job_attempts where job_id=$1",
      [job!.id],
    );
    expect(attempt.rows[0]?.outcome).toBe("CANCELLED");
    expect(attempt.rows[0]?.ended_at).not.toBeNull();
  });
});
