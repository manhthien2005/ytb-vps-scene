import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
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
} = vi.hoisted(() => ({
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

import HomePage from "./page";

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

  afterEach(() => vi.unstubAllGlobals());

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
});
