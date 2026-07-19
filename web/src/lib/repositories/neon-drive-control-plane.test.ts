// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_FILE_SCOPE, type UploadIntent } from "@/lib/domain/drive";
import type { UsageSnapshot } from "@/lib/ports/drive";

vi.mock("server-only", () => ({}));

import { createDriveControlPlaneRepository } from "./neon-drive-control-plane";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "20000000-0000-4000-8000-000000000001";

describe("Drive control-plane repository", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  });

  afterEach(async () => {
    await db.close();
  });

  function repo() {
    return createDriveControlPlaneRepository({
      query: (text, parameters) => db.query(text, parameters),
    });
  }

  async function readyProject() {
    const repository = repo();
    const reserved = await repository.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Demo",
    });
    expect(reserved.outcome).toBe("CREATED");
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    return repository.completeProjectFolders(
      reserved.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
    );
  }

  it("consumes a saved OAuth nonce once and prunes expired entries", async () => {
    const repository = repo();
    await repository.saveOAuthNonce(HASH_A, new Date(NOW.getTime() + 60_000));
    await repository.saveOAuthNonce(HASH_B, new Date(NOW.getTime() - 1));

    await expect(repository.consumeOAuthNonce(HASH_A, NOW)).resolves.toBe(true);
    await expect(repository.consumeOAuthNonce(HASH_A, NOW)).resolves.toBe(false);
    const rows = await db.query("select nonce_hash from oauth_states");
    expect(rows.rows).toHaveLength(0);
  });

  it("reserves projects idempotently and rejects a changed request", async () => {
    const repository = repo();
    const input = { idempotencyKeyHash: HASH_A, requestHash: HASH_B, name: "Demo" } as const;

    const created = await repository.reserveProject(input);
    expect(created).toMatchObject({ outcome: "CREATED", project: { status: "PROVISIONING" } });
    await expect(repository.reserveProject(input)).resolves.toMatchObject({ outcome: "RESUME" });
    await expect(repository.reserveProject({ ...input, requestHash: "c".repeat(64) }))
      .resolves.toEqual({ outcome: "CONFLICT" });

    if (created.outcome === "CONFLICT") throw new Error("unexpected conflict");
    await repository.completeProjectFolders(
      created.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
    );
    await expect(repository.reserveProject(input)).resolves.toMatchObject({
      outcome: "EXISTING",
      project: { status: "READY" },
    });
  });

  it("fails closed when project rows contain invalid data", async () => {
    await db.exec("alter table projects drop constraint projects_status_check");
    await db.query(
      `insert into projects(
         id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash
       ) values ($1,'WRONG','Demo','NO_SOURCE',$2,$3)`,
      [PROJECT_ID, HASH_A, HASH_B],
    );

    await expect(repo().listProjects()).rejects.toThrow("Invalid project row returned by database");
  });

  it("stores encrypted credentials and clears secrets on reauthentication", async () => {
    const repository = repo();
    await expect(repository.getCredential()).resolves.toBeNull();
    await repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: {
        ciphertext: Buffer.from("refresh-token").toString("base64url"),
        nonce: Buffer.alloc(12, 1).toString("base64url"),
        authTag: Buffer.alloc(16, 2).toString("base64url"),
        keyVersion: 1,
        scope: DRIVE_FILE_SCOPE,
      },
      accountPermissionIdHash: HASH_A,
      accountHint: "a***@example.com",
      rootFolderId: "drive-root-folder-001",
    });
    await expect(repository.getCredential()).resolves.toMatchObject({
      status: "CONNECTED",
      accountPermissionIdHash: HASH_A,
      envelope: { keyVersion: 1, scope: DRIVE_FILE_SCOPE },
    });

    await repository.setCredentialStatus("REAUTH_REQUIRED");
    await expect(repository.getCredential()).resolves.toEqual({
      status: "REAUTH_REQUIRED",
      envelope: null,
      accountPermissionIdHash: HASH_A,
      accountHint: "a***@example.com",
      rootFolderId: "drive-root-folder-001",
    });
  });

  it("persists the complete source artifact lifecycle without session URIs", async () => {
    const project = await readyProject();
    const repository = repo();
    const intent: UploadIntent = {
      fileName: "source.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4",
    };
    const source = await repository.reserveSourceArtifact({
      ...intent,
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveFileId: "drive-source-file-001",
      driveParentId: project.driveInputFolderId!,
    });
    expect(source).toMatchObject({ id: ARTIFACT_ID, status: "PENDING", expectedSizeBytes: 100 });
    await expect(repository.reserveSourceArtifact({
      ...intent,
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveFileId: "drive-source-file-001",
      driveParentId: project.driveInputFolderId!,
    })).resolves.toEqual(source);

    await repository.markArtifactUploading(ARTIFACT_ID);
    await repository.markSourceReady(ARTIFACT_ID, 100, NOW);
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toMatchObject({
      status: "READY",
      actualSizeBytes: 100,
    });
    await expect(repository.appManagedDriveBytes()).resolves.toBe(100);

    await repository.markSourceInvalid(ARTIFACT_ID);
    await repository.markSourceDeleted(ARTIFACT_ID);
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toMatchObject({ status: "DELETED" });
    await expect(repository.appManagedDriveBytes()).resolves.toBe(0);
  });

  it("rejects reuse of an artifact reservation with different immutable identity", async () => {
    const project = await readyProject();
    const repository = repo();
    const source = {
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveFileId: "drive-source-file-001",
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4" as const,
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4" as const,
    };
    await repository.reserveSourceArtifact(source);

    await expect(repository.reserveSourceArtifact({ ...source, sizeBytes: 101 }))
      .rejects.toThrow("Artifact reservation mismatch");
  });

  it("saves usage snapshots, reports content, database bytes, and bounded audits", async () => {
    const repository = repo();
    const snapshot: UsageSnapshot = {
      provider: "DRIVE",
      usedBytes: 20,
      limitBytes: 100,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    };
    await expect(repository.hasDriveContent()).resolves.toBe(false);
    await repository.saveUsage(snapshot);
    await expect(repository.getUsage("DRIVE")).resolves.toEqual(snapshot);
    await expect(repository.databaseUsedBytes()).resolves.toSatisfy(
      (value: number) => Number.isSafeInteger(value) && value >= 0,
    );
    await repository.recordAudit({
      eventType: "DRIVE_CONNECTED",
      actorClass: "admin",
      payload: { ok: true },
    });
    const audit = await db.query<{ event_type: string }>("select event_type from audit_events");
    expect(audit.rows[0]?.event_type).toBe("DRIVE_CONNECTED");

    await readyProject();
    await expect(repository.hasDriveContent()).resolves.toBe(true);
  });
});

describe("FakeDriveControlPlaneRepository", () => {
  it("consumes nonces once and isolates stored audit payloads", async () => {
    const fake = new FakeDriveControlPlaneRepository();
    await fake.saveOAuthNonce(HASH_A, new Date(NOW.getTime() + 60_000));
    await expect(fake.consumeOAuthNonce(HASH_A, NOW)).resolves.toBe(true);
    await expect(fake.consumeOAuthNonce(HASH_A, NOW)).resolves.toBe(false);

    const payload = { ok: true };
    await fake.recordAudit({ eventType: "DRIVE_CONNECTED", actorClass: "admin", payload });
    payload.ok = false;
    expect(fake.auditEvents).toEqual([
      { eventType: "DRIVE_CONNECTED", actorClass: "admin", payload: { ok: true } },
    ]);
  });
});
