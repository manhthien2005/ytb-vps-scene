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

  it("reserves and completes one output only under the active fence", async () => {
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

    const reservation = {
      artifactId: "50000000-0000-4000-8000-000000000001",
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: "drive-output-001",
      driveParentId: "drive-project-001",
      sizeBytes: 1234,
      checksumSha256: "a".repeat(64),
      now: NOW,
    };
    await expect(repository.reserveOutput(reservation)).resolves.toBe("RESERVED");
    await expect(repository.reserveOutput(reservation)).resolves.toBe("REPLAY");
    await expect(repository.completeOutput({
      artifactId: reservation.artifactId,
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: "drive-output-001",
      sizeBytes: 1234,
      now: NOW,
    })).resolves.toBe("COMPLETED");
    await expect(repository.completeOutput({
      artifactId: reservation.artifactId,
      jobId: job!.id,
      workerId: worker.id,
      fencingToken: 1,
      driveFileId: "drive-output-001",
      sizeBytes: 1234,
      now: NOW,
    })).resolves.toBe("REPLAY");
  });
});
