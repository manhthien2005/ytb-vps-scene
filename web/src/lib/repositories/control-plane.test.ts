// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeControlPlaneRepository } from "@/test/fakes/fake-control-plane";
import { createControlPlaneRepository } from "./neon-control-plane";

const JOB_ID = "20000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-25T01:00:00.000Z";
const UPDATED_AT = "2026-07-25T01:15:00.000Z";
const SETTINGS_SNAPSHOT = {
  version: 2,
  sourceArtifactId: "30000000-0000-4000-8000-000000000001",
  split: { mode: "fixedSeconds", secondsPerPart: 120 },
  blur: {
    mode: "manual",
    regions: [
      {
        kind: "sourceSubtitle",
        enabled: true,
        rectangle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
      },
      {
        kind: "logo",
        enabled: false,
        rectangle: { x: 0.8, y: 0.05, width: 0.1, height: 0.1 },
      },
    ],
  },
  voice: "BV074_streaming",
  rate: 1,
  output: { format: "mp4" },
  preset: { id: null, name: "Bản tin nhanh" },
  sourceSubtitle: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 },
  logo: { x: 0.8, y: 0.05, width: 0.1, height: 0.1 },
} as const;
const SOURCE_METADATA = {
  artifactId: "30000000-0000-4000-8000-000000000001",
  displayName: "source.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1_024,
  checksumSha256: "a".repeat(64),
} as const;

describe("ControlPlaneRepository contract", () => {
  it("returns newest jobs first and records immutable audit payloads", async () => {
    const repo = new FakeControlPlaneRepository([
      { id: "old", projectName: "Old", state: "READY", progressPercent: 0, updatedAt: "2026-07-18T00:00:00Z" },
      { id: "new", projectName: "New", state: "QUEUED", progressPercent: 5, updatedAt: "2026-07-19T00:00:00Z" },
    ]);
    expect((await repo.listJobs()).map((job) => job.id)).toEqual(["new", "old"]);
    const payload = { count: 2 };
    await repo.recordAudit({ eventType: "JOBS_VIEWED", actorClass: "admin", payload });
    expect(repo.auditEvents[0]?.payload).toEqual({ count: 2 });
  });

  it("blocks the sixth login attempt in one fifteen-minute window", async () => {
    const repo = new FakeControlPlaneRepository();
    const now = new Date("2026-07-19T00:00:00Z");
    for (let count = 0; count < 5; count += 1) expect((await repo.consumeLoginAttempt("a".repeat(64), now)).allowed).toBe(true);
    expect(await repo.consumeLoginAttempt("a".repeat(64), now)).toEqual({ allowed: false, retryAfterSeconds: 900 });
    await repo.clearLoginAttempts("a".repeat(64));
    expect((await repo.consumeLoginAttempt("a".repeat(64), now)).allowed).toBe(true);
  });
});

describe("persisted control-plane job regressions", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  });

  afterEach(async () => {
    await db.close();
  });

  function repository() {
    return createControlPlaneRepository({
      query: (text, parameters) => db.query(text, parameters),
    });
  }

  async function seedJob(state: "RENDER" | "COMPLETED" = "RENDER") {
    await db.query(
      `insert into jobs(
         id,project_name,state,progress_percent,created_at,updated_at,settings_snapshot,
         source_metadata,active_phase,phase_progress_percent,latest_message,eta_seconds,started_at
       ) values ($1,'Video kiểm chứng',$2,$3,$4,$5,$6::jsonb,$7::jsonb,'render',68,
         'Đang dựng khung hình',90,$4)`,
      [
        JOB_ID,
        state,
        state === "COMPLETED" ? 100 : 72,
        CREATED_AT,
        UPDATED_AT,
        JSON.stringify(SETTINGS_SNAPSHOT),
        JSON.stringify(SOURCE_METADATA),
      ],
    );
  }

  it("returns the persisted job detail read model and a null result for a missing job", async () => {
    await seedJob();
    await db.query(
      `insert into job_progress_history(job_id,phase,progress_percent,message,recorded_at)
       values ($1,'render',68,'Đang dựng khung hình',$2)`,
      [JOB_ID, "2026-07-25T01:14:00.000Z"],
    );

    const detail = await repository().getJobDetail(JOB_ID);

    expect(detail).toMatchObject({
      id: JOB_ID,
      projectName: "Video kiểm chứng",
      state: "RENDER",
      progressPercent: 72,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
      settingsSnapshot: SETTINGS_SNAPSHOT,
      sourceMetadata: SOURCE_METADATA,
      telemetry: {
        activePhase: "render",
        phaseProgressPercent: 68,
        latestMessage: "Đang dựng khung hình",
        etaSeconds: 90,
        startedAt: CREATED_AT,
        completedAt: null,
        cancelRequestedAt: null,
        errorCode: null,
        errorMessage: null,
      },
      progressHistory: [{
        phase: "render",
        progressPercent: 68,
        message: "Đang dựng khung hình",
        recordedAt: "2026-07-25T01:14:00.000Z",
      }],
      outputMetadata: null,
      workerSummary: null,
      attemptSummary: {
        count: 0,
        activeCount: 0,
        latestStartedAt: null,
        latestEndedAt: null,
        latestOutcome: null,
      },
      canCancel: true,
      canRetry: false,
    });
    await expect(repository().getJobDetail("missing-job")).resolves.toBeNull();
  });

  it("makes cancellation idempotent without moving the timestamp on a repeated request", async () => {
    await seedJob();
    const firstRequestAt = new Date("2026-07-25T01:16:00.000Z");
    const repeatedRequestAt = new Date("2026-07-25T01:17:00.000Z");
    const repo = repository();

    await expect(repo.requestJobCancellation(JOB_ID, firstRequestAt)).resolves.toBe("REQUESTED");
    await expect(repo.requestJobCancellation(JOB_ID, repeatedRequestAt)).resolves.toBe("NOT_CANCELABLE");

    const stored = await db.query<{
      state: string;
      cancel_requested_at: string;
      updated_at: string;
    }>(
      "select state,cancel_requested_at,updated_at from jobs where id=$1",
      [JOB_ID],
    );
    expect(stored.rows[0]?.state).toBe("CANCEL_REQUESTED");
    expect(new Date(stored.rows[0]!.cancel_requested_at).toISOString()).toBe(firstRequestAt.toISOString());
    expect(new Date(stored.rows[0]!.updated_at).toISOString()).toBe(firstRequestAt.toISOString());
  });

  it("does not overwrite a terminal state won by a cancellation race", async () => {
    await seedJob();
    let stateReads = 0;
    const repo = createControlPlaneRepository({
      query: async (text, parameters) => {
        if (text === "select state from jobs where id=$1") {
          stateReads += 1;
          if (stateReads === 1) return { rows: [{ state: "RENDER" }] };
        }
        if (text.includes("set state='CANCEL_REQUESTED'")) {
          await db.query("update jobs set state='COMPLETED' where id=$1", [JOB_ID]);
        }
        return db.query(text, parameters);
      },
    });

    await expect(
      repo.requestJobCancellation(JOB_ID, new Date("2026-07-25T01:16:00.000Z")),
    ).resolves.toBe("ALREADY_TERMINAL");

    const stored = await db.query<{
      state: string;
      cancel_requested_at: string | null;
      updated_at: string;
    }>(
      "select state,cancel_requested_at,updated_at from jobs where id=$1",
      [JOB_ID],
    );
    expect(stateReads).toBe(2);
    expect(stored.rows[0]?.state).toBe("COMPLETED");
    expect(stored.rows[0]?.cancel_requested_at).toBeNull();
    expect(new Date(stored.rows[0]!.updated_at).toISOString()).toBe(UPDATED_AT);
  });
});
