import { describe, expect, it } from "vitest";
import { FakeControlPlaneRepository } from "@/test/fakes/fake-control-plane";

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
