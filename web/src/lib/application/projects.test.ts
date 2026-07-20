import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";
import { FakeDriveControlPlaneRepository } from "@/test/fakes/fake-drive-control-plane";
import { FakeGoogleDriveFiles } from "@/test/fakes/fake-google-drive";
import { createProjectService } from "./projects";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("createProjectService", () => {
  it("resumes provisioning with the same deterministic folder identity", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const request = { idempotencyKey: "0123456789abcdef", name: "Test 1" };
    const reserved = await repository.reserveProject({
      idempotencyKeyHash: sha256(request.idempotencyKey),
      requestHash: sha256(JSON.stringify({ name: request.name })),
      name: request.name,
    });
    if (reserved.outcome === "CONFLICT") throw new Error("unexpected conflict");
    const files = new FakeGoogleDriveFiles();
    vi.spyOn(files, "ensureProjectFolders").mockResolvedValue({
      projectFolderId: "project-folder-001",
      inputFolderId: "input-folder-001",
    });
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });

    await expect(service.createProject(request)).resolves.toMatchObject({
      outcome: "REPLAYED",
      project: { id: reserved.project.id, status: "READY" },
    });
    expect(files.ensureProjectFolders).toHaveBeenCalledWith("access", reserved.project.id, "Test 1");
  });

  it("returns a ready replay without calling Drive", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const files = new FakeGoogleDriveFiles();
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });
    const request = { idempotencyKey: "0123456789abcdef", name: "Test 1" };
    const created = await service.createProject(request);
    expect(created.outcome).toBe("CREATED");
    files.ensureProjectFoldersCalls.length = 0;

    await expect(service.createProject(request)).resolves.toEqual({
      outcome: "REPLAYED",
      project: created.project,
    });
    expect(files.ensureProjectFoldersCalls).toHaveLength(0);
  });

  it("marks only conclusive remote mismatch as failed", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const markProjectFailed = vi.spyOn(repository, "markProjectFailed");
    const files = new FakeGoogleDriveFiles();
    vi.spyOn(files, "ensureProjectFolders")
      .mockRejectedValue(new AppError("DRIVE_REMOTE_MISMATCH", 502));
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });

    await expect(service.createProject({
      idempotencyKey: "0123456789abcdef",
      name: "Test 1",
    })).rejects.toThrow("DRIVE_REMOTE_MISMATCH");
    const project = (await repository.listProjects())[0]!;
    expect(markProjectFailed).toHaveBeenCalledWith(project.id, expect.any(String));
    expect(project.status).toBe("FAILED");
  });

  it("leaves provisioning resumable after an inconclusive failure", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const markProjectFailed = vi.spyOn(repository, "markProjectFailed");
    const files = new FakeGoogleDriveFiles();
    vi.spyOn(files, "ensureProjectFolders").mockRejectedValue(new Error("temporary failure"));
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });

    await expect(service.createProject({
      idempotencyKey: "0123456789abcdef",
      name: "Test 1",
    })).rejects.toThrow("temporary failure");
    expect(markProjectFailed).not.toHaveBeenCalled();
    await expect(repository.listProjects()).resolves.toEqual([
      expect.objectContaining({ status: "PROVISIONING" }),
    ]);
  });

  it("rejects reuse of an idempotency key for a changed normalized request", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const files = new FakeGoogleDriveFiles();
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });
    await service.createProject({ idempotencyKey: "0123456789abcdef", name: "  Test 1  " });

    await expect(service.createProject({
      idempotencyKey: "0123456789abcdef",
      name: "Test 2",
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    await expect(repository.listProjects()).resolves.toEqual([
      expect.objectContaining({ name: "Test 1" }),
    ]);
  });

  it("retries a crash with one deterministic remote folder identity", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const completeProjectFolders = repository.completeProjectFolders.bind(repository);
    vi.spyOn(repository, "completeProjectFolders")
      .mockRejectedValueOnce(new Error("simulated crash"))
      .mockImplementation(completeProjectFolders);
    const files = new FakeGoogleDriveFiles();
    const remoteProjectIds = new Set<string>();
    vi.spyOn(files, "ensureProjectFolders").mockImplementation(async (_accessToken, projectId) => {
      remoteProjectIds.add(projectId);
      return {
        projectFolderId: `project-${projectId}`,
        inputFolderId: `input-${projectId}`,
      };
    });
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });
    const request = { idempotencyKey: "0123456789abcdef", name: "Test 1" };

    await expect(service.createProject(request)).rejects.toThrow("simulated crash");
    await expect(service.createProject(request)).resolves.toMatchObject({
      outcome: "REPLAYED",
      project: { status: "READY" },
    });
    expect(remoteProjectIds.size).toBe(1);
    expect(files.ensureProjectFolders).toHaveBeenCalledTimes(2);
  });

  it("allows only one concurrent provider provisioner for the same idempotency key", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const files = new FakeGoogleDriveFiles();
    let releaseProvisioning!: () => void;
    const provisioningBlocked = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    vi.spyOn(files, "ensureProjectFolders").mockImplementation(async () => {
      await provisioningBlocked;
      return {
        projectFolderId: "project-folder-001",
        inputFolderId: "input-folder-001",
      };
    });
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });
    const request = { idempotencyKey: "0123456789abcdef", name: "Test 1" };

    const first = service.createProject(request);
    await vi.waitFor(() => expect(files.ensureProjectFolders).toHaveBeenCalledOnce());
    const second = service.createProject(request);
    const settled = Promise.allSettled([first, second]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseProvisioning();

    const results = await settled;
    expect(files.ensureProjectFolders).toHaveBeenCalledOnce();
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "DRIVE_TEMPORARILY_UNAVAILABLE", status: 503 }),
      }),
    ]));

    await expect(service.createProject(request)).resolves.toMatchObject({
      outcome: "REPLAYED",
      project: { status: "READY" },
    });
  });

  it("serializes shared Drive folder ancestors across different projects", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const files = new FakeGoogleDriveFiles();
    let releaseProvisioning!: () => void;
    const provisioningBlocked = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    vi.spyOn(files, "ensureProjectFolders").mockImplementation(async (_access, projectId) => {
      await provisioningBlocked;
      return {
        projectFolderId: `project-${projectId}`,
        inputFolderId: `input-${projectId}`,
      };
    });
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files,
    });

    const first = service.createProject({ idempotencyKey: "project-key-one", name: "One" });
    await vi.waitFor(() => expect(files.ensureProjectFolders).toHaveBeenCalledOnce());
    const second = service.createProject({ idempotencyKey: "project-key-two", name: "Two" });
    const secondSettled = Promise.allSettled([second]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(files.ensureProjectFolders).toHaveBeenCalledOnce();
    await expect(secondSettled).resolves.toEqual([
      expect.objectContaining({
        status: "rejected",
        reason: expect.objectContaining({ code: "DRIVE_TEMPORARILY_UNAVAILABLE", status: 503 }),
      }),
    ]);

    releaseProvisioning();
    await expect(first).resolves.toMatchObject({ outcome: "CREATED", project: { status: "READY" } });
    await expect(service.createProject({ idempotencyKey: "project-key-two", name: "Two" }))
      .resolves.toMatchObject({ outcome: "REPLAYED", project: { status: "READY" } });
    expect(files.ensureProjectFolders).toHaveBeenCalledTimes(2);
  });

  it("records creation audit and lists domain projects", async () => {
    const repository = new FakeDriveControlPlaneRepository();
    const service = createProjectService({
      repository,
      access: { getAccessToken: vi.fn().mockResolvedValue("access") },
      files: new FakeGoogleDriveFiles(),
    });

    const result = await service.createProject({
      idempotencyKey: "0123456789abcdef",
      name: "Test 1",
    });
    expect(result.outcome).toBe("CREATED");
    expect(repository.auditEvents).toEqual([{
      eventType: "PROJECT_CREATED",
      targetId: result.project.id,
      actorClass: "admin",
      payload: { status: "READY" },
    }]);
    await expect(service.listProjects()).resolves.toEqual([result.project]);
  });
});
