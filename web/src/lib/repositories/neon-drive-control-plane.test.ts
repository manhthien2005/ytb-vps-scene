// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRIVE_FILE_SCOPE, type UploadIntent } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import type { UsageSnapshot } from "@/lib/ports/drive";
import type { DriveFilesPort } from "@/lib/ports/drive";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";

vi.mock("server-only", () => ({}));

import { createDriveControlPlaneRepository } from "./neon-drive-control-plane";
import { PROJECT_TREE_CLAIM_ID } from "./drive-control-plane";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";

const NOW = new Date("2026-07-19T12:00:00.000Z");
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PROJECT_ID = "10000000-0000-4000-8000-000000000001";
const ARTIFACT_ID = "20000000-0000-4000-8000-000000000001";
const CLAIM_TOKEN = "30000000-0000-4000-8000-000000000001";
const SOURCE_ID = "20000000-0000-4000-8000-000000000002";
const OUTPUT_ID = "20000000-0000-4000-8000-000000000003";
const DELETED_ID = "20000000-0000-4000-8000-000000000004";

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
    await repository.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    const project = await repository.completeProjectFolders(
      reserved.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    await repository.releaseProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    await repository.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN);
    return project;
  }

  async function reserveTrackedSource(sizeBytes = 100) {
    const project = await readyProject();
    const repository = repo();
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    await repository.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN);
    const capacityInput = {
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4" as const,
      sizeBytes,
      claimToken: CLAIM_TOKEN,
      now: NOW,
      softPercent: 90,
      staleAfterSeconds: 900,
    };
    await expect(repository.reserveSourceCapacity(capacityInput)).resolves.toBe("RESERVED");
    await repository.reserveSourceArtifact({
      ...capacityInput,
      driveFileId: "drive-source-file-001",
      lastModified: 1,
      normalizedExtension: "mp4",
    }, CLAIM_TOKEN);
    return { project, repository, capacityInput };
  }

  async function seedManagedArtifacts() {
    const project = await readyProject();
    await db.query("update projects set name='Phim A',source_status='SOURCE_READY' where id=$1", [project.id]);
    for (const [id, kind, status] of [
      [SOURCE_ID, "SOURCE", "READY"],
      [OUTPUT_ID, "OUTPUT", "READY"],
      [DELETED_ID, "SOURCE", "DELETED"],
    ] as const) {
      await db.query(
        `insert into artifacts(
           id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,
           expected_size_bytes,actual_size_bytes,verified_at
         ) values ($1,$2,$3,$4,$5,$6,$7,'video/mp4',100,100,$8)`,
        [
          id, project.id, kind, status, `drive-file-${id.slice(-3)}`,
          project.driveInputFolderId!, `${kind.toLowerCase()}.mp4`, NOW,
        ],
      );
    }
    return { project, repository: repo() };
  }

  it("lists live source and output videos with project and verification metadata", async () => {
    const { repository } = await seedManagedArtifacts();

    const records = await repository.listManagedArtifacts();

    expect(records.map((record) => ({
      id: record.artifact.id,
      kind: record.artifact.kind,
      projectName: record.projectName,
      verifiedAt: record.verifiedAt,
    }))).toEqual([
      { id: SOURCE_ID, kind: "SOURCE", projectName: "Phim A", verifiedAt: NOW.toISOString() },
      { id: OUTPUT_ID, kind: "OUTPUT", projectName: "Phim A", verifiedAt: NOW.toISOString() },
    ]);
  });

  it("deletes a ready source and resets only its project source state", async () => {
    const { project, repository } = await seedManagedArtifacts();

    await expect(repository.claimManagedArtifactDeletion(SOURCE_ID)).resolves.toBe("CLAIMED");
    await expect(repository.markManagedArtifactDeleted(SOURCE_ID)).resolves.toBe("CHANGED");

    expect((await repository.getProject(project.id))?.sourceStatus).toBe("NO_SOURCE");
  });

  it("deletes a ready output without changing project source state", async () => {
    const { project, repository } = await seedManagedArtifacts();

    await expect(repository.claimManagedArtifactDeletion(OUTPUT_ID)).resolves.toBe("CLAIMED");
    await expect(repository.markManagedArtifactDeleted(OUTPUT_ID)).resolves.toBe("CHANGED");

    expect((await repository.getProject(project.id))?.sourceStatus).toBe("SOURCE_READY");
  });

  it("consumes a saved OAuth nonce once and prunes expired entries", async () => {
    const repository = repo();
    const now = new Date();
    await repository.saveOAuthNonce(HASH_A, new Date(now.getTime() + 60_000));
    await repository.saveOAuthNonce(HASH_B, new Date(now.getTime() - 1));

    await expect(repository.consumeOAuthNonce(HASH_A, now)).resolves.toBe(true);
    await expect(repository.consumeOAuthNonce(HASH_A, now)).resolves.toBe(false);
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
    await repository.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    await repository.completeProjectFolders(
      created.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    await repository.releaseProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    await expect(repository.reserveProject(input)).resolves.toMatchObject({
      outcome: "EXISTING",
      project: { status: "READY" },
    });
  });

  it("returns null when a project is absent", async () => {
    await expect(repo().getProject(PROJECT_ID)).resolves.toBeNull();
  });

  it("returns every validated field for an existing project", async () => {
    const repository = repo();
    const reserved = await repository.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Demo",
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");

    await expect(repository.getProject(reserved.project.id)).resolves.toEqual(reserved.project);
  });

  it.each([
    ["id", "wrong"],
    ["status", "WRONG"],
    ["name", " Demo"],
    ["source_status", "WRONG"],
    ["drive_project_folder_id", "short"],
    ["drive_input_folder_id", "short"],
    ["created_at", "not-a-date"],
    ["updated_at", "not-a-date"],
  ])("fails closed when getProject returns an invalid %s", async (field, value) => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: PROJECT_ID,
        status: "READY",
        name: "Demo",
        source_status: "NO_SOURCE",
        drive_project_folder_id: "drive-project-folder-001",
        drive_input_folder_id: "drive-input-folder-001",
        created_at: NOW,
        updated_at: NOW,
        [field]: value,
      }],
    });

    await expect(createDriveControlPlaneRepository({ query }).getProject(PROJECT_ID))
      .rejects.toThrow("Invalid project row returned by database");
  });

  it("marks only provisioning projects as failed", async () => {
    const repository = repo();
    const provisioning = await repository.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Provisioning",
    });
    const ready = await repository.reserveProject({
      idempotencyKeyHash: "c".repeat(64),
      requestHash: "d".repeat(64),
      name: "Ready",
    });
    const failed = await repository.reserveProject({
      idempotencyKeyHash: "e".repeat(64),
      requestHash: "f".repeat(64),
      name: "Failed",
    });
    if (provisioning.outcome === "CONFLICT" || ready.outcome === "CONFLICT" || failed.outcome === "CONFLICT") {
      throw new Error("unexpected conflict");
    }
    await repository.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    await repository.completeProjectFolders(
      ready.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    await db.query("update projects set status='FAILED' where id=$1", [failed.project.id]);

    await repository.markProjectFailed(provisioning.project.id, CLAIM_TOKEN);
    await repository.markProjectFailed(ready.project.id, CLAIM_TOKEN);
    await repository.markProjectFailed(failed.project.id, CLAIM_TOKEN);

    await expect(repository.getProject(provisioning.project.id)).resolves.toMatchObject({ status: "FAILED" });
    await expect(repository.getProject(ready.project.id)).resolves.toMatchObject({ status: "READY" });
    await expect(repository.getProject(failed.project.id)).resolves.toMatchObject({ status: "FAILED" });
  });

  it("serializes concurrent project reservations for the same idempotency key", async () => {
    const repository = repo();
    const input = { idempotencyKeyHash: HASH_A, requestHash: HASH_B, name: "Demo" } as const;
    const results = await Promise.all([
      repository.reserveProject(input),
      repository.reserveProject(input),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "RESUME"]);
    const projectIds = results.flatMap((result) => result.outcome === "CONFLICT" ? [] : [result.project.id]);
    expect(new Set(projectIds).size).toBe(1);
  });

  it("leases one database-backed provider provisioner and recovers an expired claim", async () => {
    const repository = repo();
    const reserved = await repository.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Demo",
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    const firstToken = "30000000-0000-4000-8000-000000000001";
    const secondToken = "30000000-0000-4000-8000-000000000002";

    await expect(repository.claimProvisioning("PROJECT", reserved.project.id, firstToken))
      .resolves.toBe(true);
    await expect(repository.claimProvisioning("PROJECT", reserved.project.id, secondToken))
      .resolves.toBe(false);
    await repository.releaseProvisioning("PROJECT", reserved.project.id, secondToken);
    await expect(repository.claimProvisioning("PROJECT", reserved.project.id, secondToken))
      .resolves.toBe(false);
    await repository.releaseProvisioning("PROJECT", reserved.project.id, firstToken);
    await expect(repository.claimProvisioning("PROJECT", reserved.project.id, secondToken))
      .resolves.toBe(true);

    await db.exec("update drive_provisioning_claims set expires_at=now()-interval '1 second'");
    await expect(repository.claimProvisioning("PROJECT", reserved.project.id, firstToken))
      .resolves.toBe(true);
  });

  it("does not let a stale owner renew after the takeover owner releases its claim", async () => {
    const repository = repo();
    const replacementToken = "30000000-0000-4000-8000-000000000002";
    await expect(repository.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN))
      .resolves.toBe(true);
    await db.query(
      `update drive_provisioning_claims set expires_at=now()-interval '1 second'
       where resource_kind='SOURCE' and resource_id=$1`,
      [ARTIFACT_ID],
    );
    await expect(repository.claimProvisioning("SOURCE", ARTIFACT_ID, replacementToken))
      .resolves.toBe(true);
    await repository.releaseProvisioning("SOURCE", ARTIFACT_ID, replacementToken);

    const renewalOnly = repository as typeof repository & {
      renewProvisioning(kind: "SOURCE", resourceId: string, claimToken: string): Promise<boolean>;
    };
    await expect(renewalOnly.renewProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN))
      .resolves.toBe(false);
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

  it("rejects noncanonical credential encodings before writing", async () => {
    const repository = repo();
    await expect(repository.saveConnectedCredential({
      status: "CONNECTED",
      envelope: {
        ciphertext: "***",
        nonce: Buffer.alloc(12, 1).toString("base64url"),
        authTag: Buffer.alloc(16, 2).toString("base64url"),
        keyVersion: 1,
        scope: DRIVE_FILE_SCOPE,
      },
      accountPermissionIdHash: HASH_A,
      accountHint: "a***@example.com",
      rootFolderId: "drive-root-folder-001",
    })).rejects.toThrow("Invalid encrypted credential");
  });

  it("fails closed when a credential row exposes an unmasked account hint", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        status: "CONNECTED",
        ciphertext: Buffer.from("ciphertext"),
        nonce: Buffer.alloc(12, 1),
        auth_tag: Buffer.alloc(16, 2),
        key_version: 1,
        scope: DRIVE_FILE_SCOPE,
        account_hint: "full@example.com",
        account_permission_id_hash: HASH_A,
        root_folder_id: "drive-root-folder-001",
      }],
    });

    await expect(createDriveControlPlaneRepository({ query }).getCredential())
      .rejects.toThrow("Invalid credential row returned by database");
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
    }, CLAIM_TOKEN);
    expect(source).toMatchObject({ id: ARTIFACT_ID, status: "PENDING", expectedSizeBytes: 100 });
    await expect(repository.reserveSourceArtifact({
      ...intent,
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveFileId: "drive-source-file-001",
      driveParentId: project.driveInputFolderId!,
    }, CLAIM_TOKEN)).resolves.toEqual(source);

    await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);
    await repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN);
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toMatchObject({
      status: "READY",
      actualSizeBytes: 100,
    });
    await expect(repository.appManagedDriveBytes()).resolves.toBe(100);
    await expect(repository.markSourceInvalid(ARTIFACT_ID, CLAIM_TOKEN))
      .rejects.toThrow("Source cannot be marked invalid");
  });

  it("atomically audits one READY winner and treats a concurrent replay as terminal", async () => {
    const { repository } = await reserveTrackedSource();
    await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);

    const outcomes = await Promise.all([
      repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN),
      repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN),
    ]);

    expect(outcomes.sort()).toEqual(["CHANGED", "REPLAY"]);
    const audits = await db.query<{
      event_type: string;
      target_id: string;
      actor_class: string;
      payload: Record<string, unknown>;
    }>(
      `select event_type,target_id,actor_class,payload
       from audit_events where target_id=$1 order by id`,
      [ARTIFACT_ID],
    );
    expect(audits.rows).toEqual([{
      event_type: "UPLOAD_COMPLETED",
      target_id: ARTIFACT_ID,
      actor_class: "admin",
      payload: {
        projectId: expect.any(String),
        artifactId: ARTIFACT_ID,
        actualSizeBytes: 100,
        mimeType: "video/mp4",
        status: "READY",
      },
    }]);
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain("drive-source-file-001");
    expect(serialized).not.toContain("drive-input-folder-001");
  });

  it("atomically audits one INVALID winner and replays after a lost response", async () => {
    const { repository } = await reserveTrackedSource();

    await expect(repository.markSourceInvalid(ARTIFACT_ID, CLAIM_TOKEN)).resolves.toBe("CHANGED");
    await expect(repository.markSourceInvalid(ARTIFACT_ID, CLAIM_TOKEN)).resolves.toBe("REPLAY");

    const audits = await db.query<{
      event_type: string;
      target_id: string;
      actor_class: string;
      payload: Record<string, unknown>;
    }>(
      `select event_type,target_id,actor_class,payload
       from audit_events where target_id=$1 order by id`,
      [ARTIFACT_ID],
    );
    expect(audits.rows).toEqual([{
      event_type: "UPLOAD_FAILED",
      target_id: ARTIFACT_ID,
      actor_class: "admin",
      payload: {
        projectId: expect.any(String),
        artifactId: ARTIFACT_ID,
        expectedSizeBytes: 100,
        mimeType: "video/mp4",
        status: "INVALID",
      },
    }]);
  });

  it("atomically audits one DELETED winner and treats a concurrent replay as terminal", async () => {
    const { repository } = await reserveTrackedSource();
    await expect(repository.claimSourceDeletion(ARTIFACT_ID)).resolves.toBe("CLAIMED");

    const outcomes = await Promise.all([
      repository.markSourceDeleted(ARTIFACT_ID),
      repository.markSourceDeleted(ARTIFACT_ID),
    ]);

    expect(outcomes.sort()).toEqual(["CHANGED", "REPLAY"]);
    const audits = await db.query<{
      event_type: string;
      target_id: string;
      actor_class: string;
      payload: Record<string, unknown>;
    }>(
      `select event_type,target_id,actor_class,payload
       from audit_events where target_id=$1 order by id`,
      [ARTIFACT_ID],
    );
    expect(audits.rows).toEqual([{
      event_type: "UPLOAD_CANCELLED",
      target_id: ARTIFACT_ID,
      actor_class: "admin",
      payload: {
        projectId: expect.any(String),
        artifactId: ARTIFACT_ID,
        expectedSizeBytes: 100,
        mimeType: "video/mp4",
        status: "DELETED",
      },
    }]);
  });

  it("does not let stale cancellation overwrite a source that completion made READY", async () => {
    const project = await readyProject();
    const repository = repo();
    await repository.reserveSourceArtifact({
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveFileId: "drive-source-file-001",
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4",
    }, CLAIM_TOKEN);
    await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);

    await repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN);

    await expect(repository.markSourceDeleted(ARTIFACT_ID))
      .rejects.toThrow("Source cannot be marked deleted");
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toMatchObject({
      status: "READY",
      actualSizeBytes: 100,
    });
    await expect(repository.getProject(project.id)).resolves.toMatchObject({
      sourceStatus: "SOURCE_READY",
    });
  });

  it("claims deletion before the remote side effect and excludes completion", async () => {
    const project = await readyProject();
    const repository = repo();
    await repository.reserveSourceArtifact({
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveFileId: "drive-source-file-001",
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4",
    }, CLAIM_TOKEN);
    await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);

    await expect(repository.claimSourceDeletion(ARTIFACT_ID)).resolves.toBe("CLAIMED");
    await expect(repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN))
      .rejects.toThrow("Source cannot be marked ready");
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toMatchObject({
      status: "DELETING",
      actualSizeBytes: null,
    });
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
    await repository.reserveSourceArtifact(source, CLAIM_TOKEN);

    await expect(repository.reserveSourceArtifact({ ...source, sizeBytes: 101 }, CLAIM_TOKEN))
      .rejects.toThrow("reservation mismatch");
  });

  it.each(["INVALID", "DELETED"] as const)(
    "atomically resets a %s source reservation for a new upload",
    async (terminalStatus) => {
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
      await repository.reserveSourceArtifact(source, CLAIM_TOKEN);
      if (terminalStatus === "INVALID") {
        await repository.markSourceInvalid(ARTIFACT_ID, CLAIM_TOKEN);
      } else {
        await repository.claimSourceDeletion(ARTIFACT_ID);
        await repository.markSourceDeleted(ARTIFACT_ID);
      }

      await expect(repository.reserveSourceArtifact({
        ...source,
        driveFileId: "drive-source-file-002",
        fileName: "replacement.mp4",
        sizeBytes: 200,
        lastModified: 2,
      }, CLAIM_TOKEN)).resolves.toMatchObject({
        id: ARTIFACT_ID,
        status: "PENDING",
        driveFileId: "drive-source-file-002",
        displayName: "replacement.mp4",
        expectedSizeBytes: 200,
        actualSizeBytes: null,
      });
      await expect(repository.listProjects()).resolves.toEqual([
        expect.objectContaining({ id: project.id, sourceStatus: "UPLOAD_PENDING" }),
      ]);
    },
  );

  it("allows only one of two concurrent live source reservations", async () => {
    const project = await readyProject();
    const repository = repo();
    const base = {
      projectId: project.id,
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4" as const,
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4" as const,
    };
    const results = await Promise.allSettled([
      repository.reserveSourceArtifact({
        ...base,
        artifactId: ARTIFACT_ID,
        driveFileId: "drive-source-file-001",
      }, CLAIM_TOKEN),
      repository.reserveSourceArtifact({
        ...base,
        artifactId: "20000000-0000-4000-8000-000000000002",
        driveFileId: "drive-source-file-002",
      }, CLAIM_TOKEN),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const live = await db.query<{ count: string }>(
      "select count(*) from artifacts where kind='SOURCE' and status<>'DELETED'",
    );
    expect(Number(live.rows[0]?.count)).toBe(1);
  });

  it("replays one upload capacity reservation without double charging it", async () => {
    const { repository, capacityInput } = await reserveTrackedSource();

    await expect(repository.reserveSourceCapacity(capacityInput)).resolves.toBe("EXISTING");
    const ledger = await db.query<{ count: string; remaining: string }>(
      `select count(*) as count,coalesce(sum(remaining_bytes),0) as remaining
       from drive_upload_reservations where released_at is null`,
    );
    expect(Number(ledger.rows[0]?.count)).toBe(1);
    expect(Number(ledger.rows[0]?.remaining)).toBe(100);
  });

  it("tracks authoritative partial progress as committed bytes plus remaining capacity", async () => {
    const { repository } = await reserveTrackedSource();

    await expect(repository.observeSourceProgress(ARTIFACT_ID, 40, CLAIM_TOKEN)).resolves.toBe(60);
    await expect(repository.observeSourceProgress(ARTIFACT_ID, 40, CLAIM_TOKEN)).resolves.toBe(60);
    await expect(repository.observeSourceProgress(ARTIFACT_ID, 39, CLAIM_TOKEN)).resolves.toBe(61);
    await expect(repository.appManagedDriveBytes()).resolves.toBe(39);
    const ledger = await db.query<{ observed_size_bytes: string; remaining_bytes: string }>(
      `select observed_size_bytes,remaining_bytes from drive_upload_reservations
       where artifact_id=$1`,
      [ARTIFACT_ID],
    );
    expect(ledger.rows.map((row) => ({
      observed: Number(row.observed_size_bytes),
      remaining: Number(row.remaining_bytes),
    }))).toEqual([{ observed: 39, remaining: 61 }]);
  });

  it("fences artifact binding after another worker takes over the source claim", async () => {
    const project = await readyProject();
    const repository = repo();
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    await repository.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN);
    const input = {
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4" as const,
      sizeBytes: 100,
      lastModified: 1,
      normalizedExtension: "mp4" as const,
    };
    await repository.reserveSourceCapacity({
      ...input,
      claimToken: CLAIM_TOKEN,
      now: NOW,
      softPercent: 90,
      staleAfterSeconds: 900,
    });
    await db.exec("update drive_provisioning_claims set expires_at=now()-interval '1 second'");
    const replacementToken = "30000000-0000-4000-8000-000000000002";
    await expect(repository.claimProvisioning("SOURCE", ARTIFACT_ID, replacementToken))
      .resolves.toBe(true);
    const fencedBind = repository.reserveSourceArtifact as unknown as (
      value: typeof input & Readonly<{ driveFileId: string }>,
      claimToken: string,
    ) => Promise<unknown>;

    await expect(fencedBind({ ...input, driveFileId: "drive-source-file-001" }, CLAIM_TOKEN))
      .rejects.toThrow("Artifact provisioning claim lost");
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toBeNull();
  });

  it("rejects stale progress and uploading mutations after a source-claim takeover", async () => {
    const { repository, project } = await reserveTrackedSource();
    await db.exec("update drive_provisioning_claims set expires_at=now()-interval '1 second'");
    const replacementToken = "30000000-0000-4000-8000-000000000005";
    await expect(repository.claimProvisioning("SOURCE", ARTIFACT_ID, replacementToken))
      .resolves.toBe(true);

    await expect(repository.observeSourceProgress(ARTIFACT_ID, 40, CLAIM_TOKEN))
      .rejects.toThrow("Source provisioning claim lost");
    await expect(repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN))
      .rejects.toThrow("Source provisioning claim lost");
    await expect(repository.getArtifact(project.id, ARTIFACT_ID)).resolves.toMatchObject({
      status: "PENDING",
    });
    const beforeOwner = await db.query<{ observed_size_bytes: number; remaining_bytes: number }>(
      `select observed_size_bytes,remaining_bytes from drive_upload_reservations
       where artifact_id=$1`,
      [ARTIFACT_ID],
    );
    expect(beforeOwner.rows).toEqual([{ observed_size_bytes: 0, remaining_bytes: 100 }]);

    await expect(repository.observeSourceProgress(ARTIFACT_ID, 40, replacementToken))
      .resolves.toBe(60);
    await expect(repository.markArtifactUploading(ARTIFACT_ID, replacementToken))
      .resolves.toBeUndefined();
    await expect(repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN))
      .rejects.toThrow("Source cannot be marked ready");
    await expect(repository.markSourceReady(ARTIFACT_ID, 100, NOW, replacementToken))
      .resolves.toBe("CHANGED");
  });

  it("atomically replaces a crash-stranded unbound capacity reservation", async () => {
    const project = await readyProject();
    const repository = repo();
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 100,
      limitBytes: 1_000,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    await repository.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN);
    const base = {
      artifactId: ARTIFACT_ID,
      projectId: project.id,
      driveParentId: project.driveInputFolderId!,
      fileName: "source.mp4",
      mimeType: "video/mp4" as const,
      sizeBytes: 100,
      claimToken: CLAIM_TOKEN,
      now: NOW,
      softPercent: 90,
      staleAfterSeconds: 900,
    };
    await expect(repository.reserveSourceCapacity(base)).resolves.toBe("RESERVED");

    await expect(repository.reserveSourceCapacity({
      ...base,
      fileName: "replacement.mp4",
      sizeBytes: 200,
    })).resolves.toBe("RESERVED");
    const ledger = await db.query<{ display_name: string; remaining_bytes: number }>(
      `select display_name,remaining_bytes from drive_upload_reservations
       where artifact_id=$1`,
      [ARTIFACT_ID],
    );
    expect(ledger.rows).toEqual([{ display_name: "replacement.mp4", remaining_bytes: 200 }]);
  });

  it("retains remaining capacity after deletion is claimed and releases only after remote deletion", async () => {
    const { repository } = await reserveTrackedSource();
    await repository.observeSourceProgress(ARTIFACT_ID, 40, CLAIM_TOKEN);
    await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);

    await expect(repository.claimSourceDeletion(ARTIFACT_ID)).resolves.toBe("CLAIMED");
    const claimed = await db.query<{ remaining_bytes: number; released_at: Date | null }>(
      `select remaining_bytes,released_at from drive_upload_reservations where artifact_id=$1`,
      [ARTIFACT_ID],
    );
    expect(claimed.rows).toEqual([{ remaining_bytes: 100, released_at: null }]);

    await expect(repository.markSourceDeleted(ARTIFACT_ID)).resolves.toBe("CHANGED");
    const deleted = await db.query<{ remaining_bytes: number; released_at: Date | null }>(
      `select remaining_bytes,released_at from drive_upload_reservations where artifact_id=$1`,
      [ARTIFACT_ID],
    );
    expect(deleted.rows[0]?.remaining_bytes).toBe(0);
    expect(deleted.rows[0]?.released_at).toBeInstanceOf(Date);
  });

  it.each(["READY", "INVALID", "CANCELLED"] as const)(
    "releases remaining capacity exactly once when a source becomes %s",
    async (terminal) => {
      const { repository } = await reserveTrackedSource();
      await repository.observeSourceProgress(ARTIFACT_ID, 40, CLAIM_TOKEN);
      if (terminal === "READY") {
        await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);
        await repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN);
      } else if (terminal === "INVALID") {
        await repository.markSourceInvalid(ARTIFACT_ID, CLAIM_TOKEN);
      } else {
        await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);
        await expect(repository.claimSourceDeletion(ARTIFACT_ID)).resolves.toBe("CLAIMED");
        await expect(repository.claimSourceDeletion(ARTIFACT_ID)).resolves.toBe("RECONCILE");
        await expect(repository.markSourceDeleted(ARTIFACT_ID)).resolves.toBe("CHANGED");
      }

      const ledger = await db.query<{ remaining_bytes: string; released_at: Date | null }>(
        `select remaining_bytes,released_at from drive_upload_reservations
         where artifact_id=$1`,
        [ARTIFACT_ID],
      );
      expect(Number(ledger.rows[0]?.remaining_bytes)).toBe(0);
      expect(ledger.rows[0]?.released_at).toBeInstanceOf(Date);
      await expect(repository.appManagedDriveBytes()).resolves.toBe(
        terminal === "READY" ? 100 : terminal === "INVALID" ? 40 : 0,
      );
    },
  );

  it("keeps a newly finalized source charged until a newer Drive snapshot observes it", async () => {
    const { repository } = await reserveTrackedSource();
    await db.exec("update usage_guards set used_bytes=700 where provider='DRIVE'");
    await repository.markArtifactUploading(ARTIFACT_ID, CLAIM_TOKEN);
    await repository.markSourceReady(ARTIFACT_ID, 100, NOW, CLAIM_TOKEN);
    const fallbackHealth = createFreeTierHealthService({
      repository,
      access: { getAccessToken: async () => "synthetic-access" },
      files: {
        inspectAccount: async () => {
          throw new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503);
        },
      } as unknown as DriveFilesPort,
      neonLimitBytes: 536_870_912,
      softPercent: 90,
      staleAfterSeconds: 900,
    });
    await expect(fallbackHealth.assertUploadAllowed(0, NOW)).resolves.toBeUndefined();

    const nextProjectId = "40000000-0000-4000-8000-000000000003";
    const nextClaimToken = "50000000-0000-4000-8000-000000000003";
    await db.query(
      `insert into projects(
         id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash,
         drive_project_folder_id,drive_input_folder_id
       ) values ($1,'READY','Next','NO_SOURCE',$2,$3,'drive-project-folder-003','drive-input-folder-003')`,
      [nextProjectId, "1".repeat(64), "2".repeat(64)],
    );
    await repository.claimProvisioning("SOURCE", nextProjectId, nextClaimToken);

    const nextInput = {
      artifactId: nextProjectId,
      projectId: nextProjectId,
      driveParentId: "drive-input-folder-003",
      fileName: "next.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      claimToken: nextClaimToken,
      now: NOW,
      softPercent: 90,
      staleAfterSeconds: 900,
    } as const;
    await expect(repository.reserveSourceCapacity(nextInput)).resolves.toBe("DRIVE_STORAGE_HIGH");

    const released = await db.query<{ released_at: Date }>(
      "select released_at from drive_upload_reservations where artifact_id=$1",
      [ARTIFACT_ID],
    );
    const newerObservation = new Date(released.rows[0]!.released_at.getTime() + 1_000);
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 800,
      limitBytes: 1_000,
      appManagedBytes: 100,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: newerObservation.toISOString(),
    });
    await expect(repository.reserveSourceCapacity({
      ...nextInput,
      sizeBytes: 50,
      now: newerObservation,
    })).resolves.toBe("RESERVED");
  });

  it("keeps progress newer than the Drive snapshot charged during admission", async () => {
    const { repository } = await reserveTrackedSource();
    await db.exec("update usage_guards set used_bytes=700 where provider='DRIVE'");
    await repository.observeSourceProgress(ARTIFACT_ID, 40, CLAIM_TOKEN);

    const nextProjectId = "40000000-0000-4000-8000-000000000004";
    const nextClaimToken = "50000000-0000-4000-8000-000000000004";
    await db.query(
      `insert into projects(
         id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash,
         drive_project_folder_id,drive_input_folder_id
       ) values ($1,'READY','Progress','NO_SOURCE',$2,$3,'drive-project-folder-004','drive-input-folder-004')`,
      [nextProjectId, "3".repeat(64), "4".repeat(64)],
    );
    await repository.claimProvisioning("SOURCE", nextProjectId, nextClaimToken);

    await expect(repository.reserveSourceCapacity({
      artifactId: nextProjectId,
      projectId: nextProjectId,
      driveParentId: "drive-input-folder-004",
      fileName: "progress.mp4",
      mimeType: "video/mp4",
      sizeBytes: 100,
      claimToken: nextClaimToken,
      now: NOW,
      softPercent: 90,
      staleAfterSeconds: 900,
    })).resolves.toBe("DRIVE_STORAGE_HIGH");
  });

  it("atomically prevents concurrent remaining-byte reservations from reaching the soft limit", async () => {
    const repository = repo();
    const projectIds = [
      "40000000-0000-4000-8000-000000000001",
      "40000000-0000-4000-8000-000000000002",
    ] as const;
    await db.query(
      `insert into projects(
         id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash,
         drive_project_folder_id,drive_input_folder_id
       ) values
         ($1,'READY','First','NO_SOURCE',$3,$4,'drive-project-folder-001','drive-input-folder-001'),
         ($2,'READY','Second','NO_SOURCE',$5,$6,'drive-project-folder-002','drive-input-folder-002')`,
      [projectIds[0], projectIds[1], "c".repeat(64), "d".repeat(64), "e".repeat(64), "f".repeat(64)],
    );
    await repository.saveUsage({
      provider: "DRIVE",
      usedBytes: 700,
      limitBytes: 1_000,
      appManagedBytes: 0,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: NOW.toISOString(),
    });
    const claimTokens = [
      "50000000-0000-4000-8000-000000000001",
      "50000000-0000-4000-8000-000000000002",
    ] as const;
    await Promise.all(projectIds.map((projectId, index) => (
      repository.claimProvisioning("SOURCE", projectId, claimTokens[index]!)
    )));
    const outcomes = await Promise.all(projectIds.map((projectId, index) => (
      repository.reserveSourceCapacity({
        artifactId: projectId,
        projectId,
        driveParentId: `drive-input-folder-00${index + 1}`,
        fileName: "source.mp4",
        mimeType: "video/mp4",
        sizeBytes: 100,
        claimToken: claimTokens[index]!,
        now: NOW,
        softPercent: 90,
        staleAfterSeconds: 900,
      })
    )));

    expect(outcomes.sort()).toEqual(["DRIVE_STORAGE_HIGH", "RESERVED"]);
    const ledger = await db.query<{ active: string; remaining: string }>(
      `select count(*) as active,coalesce(sum(remaining_bytes),0) as remaining
       from drive_upload_reservations where released_at is null`,
    );
    expect(Number(ledger.rows[0]?.active)).toBe(1);
    expect(Number(ledger.rows[0]?.remaining)).toBe(100);
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

  it("retains and returns the newest usage observation when saves finish out of order", async () => {
    const repository = repo();
    const newer: UsageSnapshot = {
      provider: "DRIVE",
      usedBytes: 200,
      limitBytes: 1_000,
      appManagedBytes: 20,
      mode: "READ_WRITE",
      reasonCodes: [],
      observedAt: "2026-07-19T12:00:02.000Z",
    };
    const older: UsageSnapshot = {
      ...newer,
      usedBytes: 100,
      appManagedBytes: 10,
      observedAt: "2026-07-19T12:00:01.000Z",
    };

    await expect(repository.saveUsage(newer)).resolves.toEqual(newer);
    await expect(repository.saveUsage(older)).resolves.toEqual(newer);
    await expect(repository.getUsage("DRIVE")).resolves.toEqual(newer);
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

  it("matches terminal source reset behavior", async () => {
    const fake = new FakeDriveControlPlaneRepository();
    const reserved = await fake.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Demo",
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    await fake.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    const project = await fake.completeProjectFolders(
      reserved.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    await fake.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN);
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
    await fake.reserveSourceArtifact(source, CLAIM_TOKEN);
    await fake.claimSourceDeletion(ARTIFACT_ID);
    await fake.markSourceDeleted(ARTIFACT_ID);

    await expect(fake.reserveSourceArtifact({
      ...source,
      driveFileId: "drive-source-file-002",
      sizeBytes: 200,
    }, CLAIM_TOKEN)).resolves.toMatchObject({ status: "PENDING", expectedSizeBytes: 200 });
  });

  it("models listed output deletion with metadata and replay semantics", async () => {
    const fake = new FakeDriveControlPlaneRepository();
    const reserved = await fake.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Phim A",
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    await fake.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    const project = await fake.completeProjectFolders(
      reserved.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    fake.seedManagedArtifact({
      artifact: {
        id: OUTPUT_ID,
        projectId: project.id,
        kind: "OUTPUT",
        status: "READY",
        driveFileId: "drive-output-file-001",
        driveParentId: project.driveProjectFolderId!,
        displayName: "output.mp4",
        mimeType: "video/mp4",
        expectedSizeBytes: 100,
        actualSizeBytes: 100,
      },
      projectName: "Phim A",
      jobId: null,
      verifiedAt: NOW.toISOString(),
    });

    await expect(fake.listManagedArtifacts()).resolves.toEqual([
      expect.objectContaining({ artifact: expect.objectContaining({ id: OUTPUT_ID }), verifiedAt: NOW.toISOString() }),
    ]);
    await expect(fake.claimManagedArtifactDeletion(OUTPUT_ID)).resolves.toBe("CLAIMED");
    await expect(fake.claimManagedArtifactDeletion(OUTPUT_ID)).resolves.toBe("RECONCILE");
    await expect(fake.markManagedArtifactDeleted(OUTPUT_ID)).resolves.toBe("CHANGED");
    await expect(fake.markManagedArtifactDeleted(OUTPUT_ID)).resolves.toBe("REPLAY");
    expect((await fake.getProject(project.id))?.sourceStatus).toBe("NO_SOURCE");
  });

  it("orders managed artifacts by creation time then artifact ID", async () => {
    let now = new Date("2026-07-19T12:00:00.000Z");
    const fake = new FakeDriveControlPlaneRepository(() => now);
    const reserved = await fake.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Phim A",
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    await fake.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    const project = await fake.completeProjectFolders(
      reserved.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    const firstId = "20000000-0000-4000-8000-000000000006";
    const laterHigherId = "20000000-0000-4000-8000-000000000003";
    const laterLowerId = "20000000-0000-4000-8000-000000000002";
    for (const id of [firstId, laterHigherId]) {
      fake.seedManagedArtifact({
        artifact: {
          id,
          projectId: project.id,
          kind: "OUTPUT",
          status: "READY",
          driveFileId: `drive-output-file-${id.slice(-3)}`,
          driveParentId: project.driveProjectFolderId!,
          displayName: `${id}.mp4`,
          mimeType: "video/mp4",
          expectedSizeBytes: 100,
          actualSizeBytes: 100,
        },
        projectName: "Phim A",
        jobId: null,
        verifiedAt: NOW.toISOString(),
      });
      now = new Date(now.getTime() + 1_000);
    }
    now = new Date(now.getTime() - 1_000);
    fake.seedManagedArtifact({
      artifact: {
        id: laterLowerId,
        projectId: project.id,
        kind: "OUTPUT",
        status: "READY",
        driveFileId: "drive-output-file-002",
        driveParentId: project.driveProjectFolderId!,
        displayName: "later-lower.mp4",
        mimeType: "video/mp4",
        expectedSizeBytes: 100,
        actualSizeBytes: 100,
      },
      projectName: "Phim A",
      jobId: null,
      verifiedAt: NOW.toISOString(),
    });

    await expect(fake.listManagedArtifacts()).resolves.toMatchObject([
      { artifact: { id: firstId } },
      { artifact: { id: laterLowerId } },
      { artifact: { id: laterHigherId } },
    ]);
  });

  it("rejects reactivating a deleted source when another source is live", async () => {
    const fake = new FakeDriveControlPlaneRepository();
    const reserved = await fake.reserveProject({
      idempotencyKeyHash: HASH_A,
      requestHash: HASH_B,
      name: "Demo",
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    await fake.claimProvisioning("PROJECT", PROJECT_TREE_CLAIM_ID, CLAIM_TOKEN);
    const project = await fake.completeProjectFolders(
      reserved.project.id,
      "drive-project-folder-001",
      "drive-input-folder-001",
      CLAIM_TOKEN,
    );
    await fake.claimProvisioning("SOURCE", ARTIFACT_ID, CLAIM_TOKEN);
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
    await fake.reserveSourceArtifact(source, CLAIM_TOKEN);
    await fake.claimSourceDeletion(ARTIFACT_ID);
    await fake.markSourceDeleted(ARTIFACT_ID);
    const competingArtifactId = "20000000-0000-4000-8000-000000000002";
    await fake.claimProvisioning("SOURCE", competingArtifactId, CLAIM_TOKEN);
    await fake.reserveSourceArtifact({
      ...source,
      artifactId: competingArtifactId,
      driveFileId: "drive-source-file-002",
    }, CLAIM_TOKEN);

    await expect(fake.reserveSourceArtifact(source, CLAIM_TOKEN))
      .rejects.toThrow("Project not ready or source already reserved");
  });
});
