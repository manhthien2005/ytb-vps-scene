import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertUploadAllowed,
  currentAdmin,
  createRepository,
  listJobs,
  createDriveRepository,
  getCredential,
  listProjects,
  getHealth,
  createWorkerRepository,
  listWorkers,
  expireWorkersAndLeases,
  requireWorkerSession,
  sqlQuery,
} = vi.hoisted(() => ({
  assertUploadAllowed: vi.fn(),
  currentAdmin: vi.fn(),
  createRepository: vi.fn(),
  listJobs: vi.fn(),
  createDriveRepository: vi.fn(),
  getCredential: vi.fn(),
  listProjects: vi.fn(),
  getHealth: vi.fn(),
  createWorkerRepository: vi.fn(),
  listWorkers: vi.fn(),
  expireWorkersAndLeases: vi.fn(),
  requireWorkerSession: vi.fn(),
  sqlQuery: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/repositories/neon-control-plane", () => ({
  createNeonControlPlaneRepository: createRepository,
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: createDriveRepository,
}));
vi.mock("@/lib/repositories/neon-worker-control-plane", () => ({
  createNeonWorkerControlPlaneRepository: createWorkerRepository,
}));
vi.mock("@/lib/adapters/google/oauth", () => ({ createGoogleOAuthAdapter: () => ({ kind: "oauth" }) }));
vi.mock("@/lib/adapters/google/drive-files", () => ({ createGoogleDriveFilesAdapter: () => ({ kind: "files" }) }));
vi.mock("@/lib/application/drive-access", () => ({ createDriveAccessProvider: () => ({ kind: "access" }) }));
vi.mock("@/lib/security/credential-cipher", () => ({ createCredentialCipher: () => ({ kind: "cipher" }) }));
vi.mock("@/lib/application/free-tier-health", () => ({
  createFreeTierHealthService: () => ({ getHealth }),
}));
vi.mock("@/lib/application/configured-health", () => ({
  createConfiguredFreeTierHealthService: () => ({ assertUploadAllowed }),
}));
vi.mock("@/lib/http/worker-auth", () => ({ requireWorkerSession }));
vi.mock("@/lib/db/client", () => ({
  createSql: () => ({ query: sqlQuery }),
}));

import HomePage from "./page";
import { GET as listJobsRoute } from "./api/v1/jobs/route";
import {
  GET as getJobRoute,
  POST as cancelJobRoute,
} from "./api/v1/jobs/[id]/route";
import {
  GET as getSceneSettingsRoute,
  PUT as saveSceneSettingsRoute,
} from "./api/v1/projects/[id]/scene-settings/route";
import { POST as queueProjectRoute } from "./api/v1/projects/[id]/jobs/route";
import { POST as reportJobProgressRoute } from "./api/v1/worker/jobs/[id]/progress/route";

describe("HomePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      input: [],
      output: [],
      processingCount: 0,
    }), { status: 200, headers: { "content-type": "application/json" } })));
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost/test",
      ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      SESSION_SECRET: "s".repeat(64),
      APP_ORIGIN: "http://localhost:3000",
      GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
      DRIVE_TOKEN_KEY_V1: "A".repeat(43),
      NEON_STORAGE_LIMIT_BYTES: "536870912",
      DRIVE_UPLOAD_MAX_BYTES: "10737418240",
      FREE_TIER_SOFT_PERCENT: "90",
      QUOTA_STALE_AFTER_SECONDS: "900",
      WORKER_AUTH_KEY_V1: "A".repeat(43),
      WORKER_RELEASE_REPOSITORY: "https://github.com/manhthien2005/ytb-vps-scene.git",
      WORKER_RELEASE_COMMIT: "a".repeat(40),
      WORKER_PIPELINE_BRIDGE_VERSION: "cp3-control-only",
    });
    delete process.env.OPENAI_API_KEY;
    currentAdmin.mockResolvedValue(false);
    createRepository.mockReturnValue({ listJobs });
    createDriveRepository.mockReturnValue({ getCredential, listProjects });
    createWorkerRepository.mockReturnValue({ listWorkers, expireWorkersAndLeases });
    listWorkers.mockResolvedValue([]);
    expireWorkersAndLeases.mockResolvedValue(undefined);
    assertUploadAllowed.mockResolvedValue(undefined);
    requireWorkerSession.mockResolvedValue({
      id: "40000000-0000-4000-8000-000000000001",
    });
    listJobs.mockResolvedValue([]);
    getCredential.mockResolvedValue(null);
    listProjects.mockResolvedValue([]);
    getHealth.mockResolvedValue({
      mode: "READ_ONLY",
      reasons: ["DRIVE_NOT_CONNECTED"],
      driveConnection: "DISCONNECTED",
      drive: null,
      neon: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not instantiate or call the repository before authentication", async () => {
    render(await HomePage());
    expect(screen.getByRole("button", { name: "Mở bảng điều khiển" })).toBeInTheDocument();
    expect(createRepository).not.toHaveBeenCalled();
    expect(createDriveRepository).not.toHaveBeenCalled();
    expect(listJobs).not.toHaveBeenCalled();
  });

  it("renders only sanitized Drive and project views after authentication", async () => {
    currentAdmin.mockResolvedValue(true);
    getCredential.mockResolvedValue({
      status: "CONNECTED",
      envelope: { ciphertext: "secret-envelope" },
      accountPermissionIdHash: "secret-account-hash",
      accountHint: "a***@example.test",
      rootFolderId: "secret-root-folder-id",
    });
    listProjects.mockResolvedValue([{
      id: "10000000-0000-4000-8000-000000000001",
      status: "READY",
      name: "Test 1",
      sourceStatus: "NO_SOURCE",
      driveProjectFolderId: "secret-project-folder-id",
      driveInputFolderId: "secret-input-folder-id",
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    }]);
    getHealth.mockResolvedValue({
      mode: "READ_WRITE",
      reasons: [],
      driveConnection: "CONNECTED",
      drive: {
        provider: "DRIVE",
        usedBytes: 100,
        limitBytes: 1_000,
        appManagedBytes: 20,
        mode: "READ_WRITE",
        reasonCodes: [],
        observedAt: "2026-07-19T00:00:00.000Z",
      },
      neon: {
        provider: "NEON",
        usedBytes: 10,
        limitBytes: 1_000,
        appManagedBytes: 0,
        mode: "READ_WRITE",
        reasonCodes: [],
        observedAt: "2026-07-19T00:00:00.000Z",
      },
    });

    const { container } = render(await HomePage());

    const nav = screen.getByRole("navigation", { name: "Điều hướng Zeus MMO" });
    fireEvent.click(within(nav).getByRole("button", { name: /Files/ }));

    expect(screen.getByText("Đã kết nối")).toBeVisible();
    expect(screen.getByText("a***@example.test")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Drive" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Input" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Output" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" })).toBeEnabled();
    expect(screen.getByLabelText("Thêm video")).toBeEnabled();
    expect(container.textContent).not.toContain("secret-root-folder-id");
    expect(container.textContent).not.toContain("secret-project-folder-id");
    expect(container.textContent).not.toContain("secret-envelope");
  });

  it("runs the source-ready settings, queue, worker progress, detail, snapshot, and cancel workflow across routes and repositories", async () => {
    const projectId = "10000000-0000-4000-8000-000000000001";
    const sourceArtifactId = "20000000-0000-4000-8000-000000000001";
    const workerId = "30000000-0000-4000-8000-000000000001";
    const requestId = "40000000-0000-4000-8000-000000000001";
    const jobId = "50000000-0000-4000-8000-000000000001";
    const projectName = "Bản tin hành vi";
    const initialSettings = {
      version: 2,
      sourceArtifactId,
      split: { mode: "fixedSeconds", secondsPerPart: 120 },
      blur: {
        mode: "manual",
        regions: [
          {
            kind: "sourceSubtitle",
            enabled: true,
            rectangle: { x: 0.05, y: 0.78, width: 0.9, height: 0.16 },
          },
          {
            kind: "logo",
            enabled: true,
            rectangle: { x: 0.78, y: 0.04, width: 0.18, height: 0.16 },
          },
        ],
      },
      voice: "BV074_streaming",
      rate: 1,
      output: { format: "mp4" },
      preset: { id: null, name: "Preset ban đầu" },
      sourceSubtitle: { x: 0.05, y: 0.78, width: 0.9, height: 0.16 },
      logo: { x: 0.78, y: 0.04, width: 0.18, height: 0.16 },
    } as const;
    const db = new PGlite();
    let unmount: (() => void) | undefined;

    try {
      await db.exec(await readFile("src/lib/db/schema.sql", "utf8"));
      await db.query(
        `insert into projects(
           id,status,name,source_status,creation_idempotency_key_hash,creation_request_hash,
           drive_project_folder_id,drive_input_folder_id,created_at,updated_at
         ) values ($1,'READY',$2,'SOURCE_READY',$3,$4,'drive-project-root','drive-input-root',$5,$5)`,
        [
          projectId,
          projectName,
          "a".repeat(64),
          "b".repeat(64),
          "2026-07-25T00:00:00.000Z",
        ],
      );
      await db.query(
        `insert into artifacts(
           id,project_id,kind,status,drive_file_id,drive_parent_id,display_name,mime_type,
           expected_size_bytes,actual_size_bytes,checksum_sha256,verified_at,created_at,updated_at
         ) values ($1,$2,'SOURCE','READY','drive-source-file','drive-input-root','source-ready.mp4',
           'video/mp4',2048,2048,$3,$4,$4,$4)`,
        [
          sourceArtifactId,
          projectId,
          "c".repeat(64),
          "2026-07-25T00:01:00.000Z",
        ],
      );
      await db.query(
        `insert into project_scene_settings(project_id,settings,updated_at)
         values ($1,$2::jsonb,$3)`,
        [
          projectId,
          JSON.stringify(initialSettings),
          "2026-07-25T00:02:00.000Z",
        ],
      );
      await db.query(
        `insert into workers(
           id,session_digest,state,account_label,capabilities,doctor_report,session_expires_at,
           heartbeat_at,created_at,updated_at
         ) values ($1,$2,'READY','fake-render-node',$3::jsonb,$4::jsonb,$5,$6,$7,$7)`,
        [
          workerId,
          "d".repeat(64),
          JSON.stringify({
            protocolVersion: 1,
            pipelineBridgeVersion: "cp4-media-v1",
            os: "ubuntu-22.04",
            arch: "x86_64",
            gpuName: "Synthetic GPU",
            vramMiB: 12_288,
            cudaVersion: "12.4",
            nvenc: true,
          }),
          JSON.stringify({
            status: "PASS",
            reasonCodes: ["CUDA_AVAILABLE", "NVENC_AVAILABLE"],
            observedAt: "2026-07-25T00:03:00.000Z",
          }),
          "2099-01-01T00:00:00.000Z",
          "2098-12-31T23:59:00.000Z",
          "2026-07-25T00:03:00.000Z",
        ],
      );

      const controlModule = await vi.importActual<
        typeof import("@/lib/repositories/neon-control-plane")
      >("@/lib/repositories/neon-control-plane");
      const workerModule = await vi.importActual<
        typeof import("@/lib/repositories/neon-worker-control-plane")
      >("@/lib/repositories/neon-worker-control-plane");
      const controlRepository = controlModule.createControlPlaneRepository({
        query: (text, parameters) => db.query(text, parameters),
      });
      const workerRepository = workerModule.createWorkerControlPlaneRepository({
        query: (text, parameters) => db.query(text, parameters),
      });

      sqlQuery.mockImplementation((text, parameters) => db.query(text, parameters));
      createRepository.mockReturnValue(controlRepository);
      createWorkerRepository.mockReturnValue(workerRepository);
      process.env.WORKER_PIPELINE_BRIDGE_VERSION = "cp4-media-v1";
      currentAdmin.mockResolvedValue(true);
      listProjects.mockResolvedValue([{
        id: projectId,
        status: "READY",
        name: projectName,
        sourceStatus: "SOURCE_READY",
        driveProjectFolderId: "private-drive-project-folder",
        driveInputFolderId: "private-drive-input-folder",
        createdAt: "2026-07-25T00:00:00.000Z",
        updatedAt: "2026-07-25T00:01:00.000Z",
      }]);
      getHealth.mockResolvedValue({
        mode: "READ_WRITE",
        reasons: [],
        driveConnection: "CONNECTED",
        drive: {
          provider: "DRIVE",
          usedBytes: 100,
          limitBytes: 1_000,
          appManagedBytes: 100,
          mode: "READ_WRITE",
          reasonCodes: [],
          observedAt: "2026-07-25T00:03:00.000Z",
        },
        neon: {
          provider: "NEON",
          usedBytes: 10,
          limitBytes: 1_000,
          appManagedBytes: 0,
          mode: "READ_WRITE",
          reasonCodes: [],
          observedAt: "2026-07-25T00:03:00.000Z",
        },
      });
      requireWorkerSession.mockResolvedValue({ id: workerId });

      const apiFetch = vi.fn<typeof fetch>(async (input, init) => {
        const inputRequest = input instanceof Request ? input : null;
        const rawUrl = inputRequest?.url ?? String(input);
        const url = new URL(rawUrl, "http://localhost:3000");
        const method = (init?.method ?? inputRequest?.method ?? "GET").toUpperCase();
        const headers = new Headers(inputRequest?.headers);
        new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
        if ((method === "POST" || method === "PUT") && !headers.has("origin")) {
          headers.set("origin", "http://localhost:3000");
        }
        const request = new NextRequest(url, {
          method,
          headers,
          body: method === "GET" || method === "HEAD" ? undefined : init?.body,
        });
        const projectSettingsMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/scene-settings$/);
        if (projectSettingsMatch) {
          const context = { params: Promise.resolve({ id: decodeURIComponent(projectSettingsMatch[1]!) }) };
          if (method === "GET") return getSceneSettingsRoute(request, context);
          if (method === "PUT") return saveSceneSettingsRoute(request, context);
        }
        const queueMatch = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)\/jobs$/);
        if (queueMatch && method === "POST") {
          return queueProjectRoute(request, {
            params: Promise.resolve({ id: decodeURIComponent(queueMatch[1]!) }),
          });
        }
        if (url.pathname === "/api/v1/jobs" && method === "GET") {
          return listJobsRoute(request);
        }
        const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
        if (jobMatch) {
          const context = { params: Promise.resolve({ id: decodeURIComponent(jobMatch[1]!) }) };
          if (method === "GET") return getJobRoute(request, context);
          if (method === "POST") return cancelJobRoute(request, context);
        }
        const progressMatch = url.pathname.match(/^\/api\/v1\/worker\/jobs\/([^/]+)\/progress$/);
        if (progressMatch && method === "POST") {
          return reportJobProgressRoute(request, {
            params: Promise.resolve({ id: decodeURIComponent(progressMatch[1]!) }),
          });
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      });
      vi.stubGlobal("fetch", apiFetch);
      vi.spyOn(globalThis.crypto, "randomUUID")
        .mockReturnValueOnce(requestId)
        .mockReturnValueOnce(jobId);

      const view = render(await HomePage());
      unmount = view.unmount;

      const presetInput = screen.getByLabelText("Tên preset");
      await waitFor(() => expect(presetInput).toHaveValue("Preset ban đầu"));
      fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "1.15" } });
      fireEvent.change(presetInput, { target: { value: "Snapshot đã xếp" } });
      fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
      expect(await screen.findByText("Đã lưu cấu hình dự án.")).toBeVisible();

      const confirmRender = screen.getByRole("button", { name: "Xác nhận render" });
      await waitFor(() => expect(confirmRender).toBeEnabled());
      fireEvent.click(confirmRender);
      expect(await screen.findByText("Đã xếp job render vào hàng đợi.")).toBeVisible();

      const queued = await controlRepository.getJobDetail(jobId);
      expect(queued).toMatchObject({
        state: "QUEUED",
        settingsSnapshot: {
          rate: 1.15,
          preset: { id: null, name: "Snapshot đã xếp" },
        },
        sourceMetadata: {
          artifactId: sourceArtifactId,
          displayName: "source-ready.mp4",
          mimeType: "video/mp4",
          sizeBytes: 2_048,
        },
      });

      fireEvent.change(screen.getByLabelText("Tốc độ voice"), { target: { value: "0.8" } });
      fireEvent.change(presetInput, { target: { value: "Preset đổi sau khi xếp" } });
      fireEvent.click(screen.getByRole("button", { name: "Lưu cấu hình" }));
      expect(await screen.findByText("Đã lưu cấu hình dự án.")).toBeVisible();

      const persistedSettings = await db.query<{ settings: typeof initialSettings }>(
        "select settings from project_scene_settings where project_id=$1",
        [projectId],
      );
      expect(persistedSettings.rows[0]?.settings).toMatchObject({
        rate: 0.8,
        preset: { id: null, name: "Preset đổi sau khi xếp" },
      });
      await expect(controlRepository.getJobDetail(jobId)).resolves.toMatchObject({
        settingsSnapshot: {
          rate: 1.15,
          preset: { id: null, name: "Snapshot đã xếp" },
        },
      });

      const assignment = await workerRepository.claimJob(
        workerId,
        new Date(),
        "cp4-media-v1",
      );
      expect(assignment).toMatchObject({
        job: { id: jobId, state: "CLAIMED" },
        lease: { fencingToken: 1 },
        execution: {
          projectId,
          sceneSettings: {
            rate: 1.15,
            preset: { id: null, name: "Snapshot đã xếp" },
          },
        },
      });

      async function reportProgress(
        fromState: string,
        state: string,
        progressPercent: number,
        telemetry: Readonly<Record<string, string | number>> = {},
      ) {
        const response = await apiFetch(`/api/v1/worker/jobs/${jobId}/progress`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fencingToken: 1,
            fromState,
            state,
            progressPercent,
            ...telemetry,
          }),
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: "UPDATED" });
      }

      await reportProgress("CLAIMED", "DOWNLOADING", 10);
      await reportProgress("DOWNLOADING", "OCR", 25);
      await reportProgress("OCR", "TRANSLATE", 40);
      await reportProgress("TRANSLATE", "TTS", 55);
      await reportProgress("TTS", "RENDER", 64, {
        phase: "render",
        phaseProgressPercent: 61,
        message: "Đang ghép cảnh kiểm chứng",
        etaSeconds: 125,
      });

      const nav = screen.getByRole("navigation", { name: "Điều hướng Zeus MMO" });
      fireEvent.click(within(nav).getByRole("button", { name: /Jobs/ }));
      fireEvent.click(screen.getByRole("button", { name: "Làm mới danh sách job" }));
      const jobRow = await screen.findByRole("listitem", { name: `Job ${projectName}` });
      expect(within(jobRow).getByRole("progressbar", { name: `Tiến độ ${projectName}` }))
        .toHaveAttribute("aria-valuenow", "64");
      expect(within(jobRow).getByText("Pha: Render (61%)")).toBeVisible();
      expect(within(jobRow).getByText("Còn khoảng 2 phút 5 giây")).toBeVisible();

      fireEvent.click(within(jobRow).getByRole("button", { name: `Xem chi tiết ${projectName}` }));
      const detailPanel = await screen.findByRole("dialog", { name: `Chi tiết job ${projectName}` });
      expect(within(detailPanel).getByText("Snapshot đã xếp")).toBeVisible();
      expect(within(detailPanel).getByText("BV074_streaming · 1.15x")).toBeVisible();
      expect(within(detailPanel).getByText("Đang ghép cảnh kiểm chứng")).toBeVisible();
      expect(within(detailPanel).getByText("source-ready.mp4 · video/mp4 · 2 KB")).toBeVisible();
      expect(within(detailPanel).queryByText("Preset đổi sau khi xếp")).not.toBeInTheDocument();

      vi.spyOn(window, "confirm").mockReturnValue(true);
      fireEvent.click(within(jobRow).getByRole("button", { name: `Hủy job ${projectName}` }));
      expect(await within(jobRow).findByText("Đang hủy")).toBeVisible();

      const cancelled = await controlRepository.getJobDetail(jobId);
      expect(cancelled).toMatchObject({
        state: "CANCEL_REQUESTED",
        telemetry: { cancelRequestedAt: expect.any(String) },
        canCancel: false,
      });
      await expect(workerRepository.renewLease({
        workerId,
        jobId,
        fencingToken: 1,
        now: new Date(),
      })).resolves.toMatchObject({
        fencingToken: 1,
        cancelRequested: true,
      });
    } finally {
      unmount?.();
      await db.close();
    }
  });
});
