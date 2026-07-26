import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardShell } from "./dashboard-shell";

const health = {
  mode: "READ_WRITE" as const,
  reasons: [],
  driveConnection: "CONNECTED" as const,
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};

describe("DashboardShell", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      input: [{
        artifactId: "20000000-0000-4000-8000-000000000001",
        name: "source.mp4",
        sizeBytes: 10 * 1_024 ** 2,
        uploadedAt: "2026-07-22T08:30:00.000Z",
        durationMillis: 10_000,
        width: 1_920,
        height: 1_080,
        readiness: "READY",
        viewUrl: "https://drive.google.com/file/d/source/view",
        downloadUrl: "https://drive.usercontent.google.com/download?id=source",
      }],
      output: [],
      processingCount: 0,
    }), { status: 200, headers: { "content-type": "application/json" } })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the Zeus shell and reveals Drive trees on the Files surface", async () => {
    render(<DashboardShell workerOnline={false} drive={{ status: "CONNECTED", accountHint: null, rootReady: true }} health={health} projects={[]} jobs={[]} workers={[]} />);

    const nav = screen.getByRole("navigation", { name: "Điều hướng Zeus MMO" });
    expect(nav).toBeVisible();
    for (const label of ["Workspace", "Files", "Jobs", "Workers", "Settings"]) {
      expect(within(nav).getByRole("button", { name: new RegExp(label) })).toBeVisible();
    }
    expect(screen.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Run your daily jobs" })).toBeVisible();

    // Drive workspace only mounts on the Files surface.
    expect(screen.queryByRole("heading", { name: "Drive" })).not.toBeInTheDocument();

    fireEvent.click(within(nav).getByRole("button", { name: /Files/ }));

    expect(screen.getByRole("heading", { level: 1, name: "Files" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Drive" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Input" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Output" })).toBeVisible();
    expect(await screen.findByText("source.mp4")).toBeVisible();
    expect(screen.getByTestId("video-icon")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kéo thả hoặc chọn video" })).toBeEnabled();
  });

  it("surfaces jobs and worker setup on their own surfaces", () => {
    render(
      <DashboardShell
        workerOnline={false}
        drive={{ status: "CONNECTED", accountHint: "a***@example.test", rootReady: true }}
        health={health}
        projects={[{
          id: "10000000-0000-4000-8000-000000000001",
          status: "READY",
          name: "Video tháng 7",
          sourceStatus: "NO_SOURCE",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
        }]}
        jobs={[
          { id: "j1", projectName: "Test 1", state: "QUEUED", progressPercent: 0, updatedAt: "2026-07-19T00:00:00Z" },
          { id: "j2", projectName: "Video tháng 7", state: "QUEUED", progressPercent: 0, updatedAt: "2026-07-19T00:00:00Z" },
        ]}
        workers={[]}
      />,
    );

    // Workspace surface lists the project (board row + inspector heading).
    expect(screen.getAllByText("Video tháng 7").length).toBeGreaterThan(0);
    const projectTable = screen.getByLabelText("Danh sách dự án");
    expect(within(projectTable).getByText("Đang chờ · 0%")).toBeVisible();
    expect(within(projectTable).getByText("Chưa có ETA")).toBeVisible();

    const nav = screen.getByRole("navigation", { name: "Điều hướng Zeus MMO" });
    fireEvent.click(within(nav).getByRole("button", { name: /Jobs/ }));
    expect(screen.getByText("Test 1")).toBeVisible();

    fireEvent.click(within(nav).getByRole("button", { name: /Workers/ }));
    const workerRegion = screen.getByRole("region", { name: "Gắn VPS" });
    expect(workerRegion).toBeVisible();
    expect(within(workerRegion).getByRole("button", { name: "Tạo lệnh gắn VPS" })).toBeEnabled();
    expect(within(workerRegion).getByText("Chưa gắn")).toBeVisible();
  });

  it("associates jobs to projects by projectId so duplicate names cannot cross-attribute", () => {
    const shared = {
      status: "READY" as const,
      sourceStatus: "SOURCE_READY" as const,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    };
    render(
      <DashboardShell
        workerOnline
        drive={{ status: "CONNECTED", accountHint: null, rootReady: true }}
        health={health}
        projects={[
          { ...shared, id: "10000000-0000-4000-8000-000000000001", name: "video.mp4" },
          { ...shared, id: "10000000-0000-4000-8000-000000000002", name: "video.mp4" },
        ]}
        jobs={[{
          id: "j1",
          projectId: "10000000-0000-4000-8000-000000000002",
          projectName: "video.mp4",
          state: "RENDER",
          progressPercent: 42,
          updatedAt: "2026-07-19T00:00:00Z",
        }]}
        workers={[]}
      />,
    );

    const projectTable = screen.getByLabelText("Danh sách dự án");
    // Only the second project (the job's real owner) shows the running job; the
    // first same-named project must not inherit it. The job-less row renders
    // "Chưa có job" in both its job and ETA cells.
    expect(within(projectTable).getAllByText("Render · 42%")).toHaveLength(1);
    expect(within(projectTable).getAllByText("Chưa có job")).toHaveLength(2);
  });

  it("guides a source-ready video through setup before monitoring its job", () => {
    render(
      <DashboardShell
        workerOnline
        drive={{ status: "CONNECTED", accountHint: null, rootReady: true }}
        health={health}
        projects={[{
          id: "10000000-0000-4000-8000-000000000001",
          status: "READY",
          name: "Video một job",
          sourceStatus: "SOURCE_READY",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
        }]}
        jobs={[{
          id: "j1",
          projectName: "Video một job",
          state: "RENDER",
          progressPercent: 42,
          etaSeconds: 90,
          updatedAt: "2026-07-19T00:00:00Z",
        }]}
        workers={[]}
      />,
    );

    expect(screen.getByText("Mỗi video tạo đúng một job render.")).toBeVisible();
    const inspector = screen.getByLabelText("Project inspector");
    expect(within(inspector).getByText("1 video • 1 thiết lập • 1 job")).toBeVisible();
    expect(within(inspector).queryByRole("button", { name: "Queue render" })).not.toBeInTheDocument();

    const projectTable = screen.getByLabelText("Danh sách dự án");
    expect(within(projectTable).getByText("Đã xác nhận")).toBeVisible();
    expect(within(projectTable).getByText("Render · 42%")).toBeVisible();
    expect(within(projectTable).getByText("Còn khoảng 2 phút")).toBeVisible();

    const setup = within(inspector).getByRole("button", { name: "Thiết lập & xem trước" });
    expect(setup).toBeEnabled();
    fireEvent.click(setup);

    expect(screen.getByRole("region", { name: "Review scene và voice" })).toHaveFocus();
    const scene = screen.getByRole("region", { name: "Blur và voice" });
    expect(within(scene).getByText("Video một job")).toBeVisible();
    expect(within(scene).getByText("Đọc/ghi")).toBeVisible();
    expect(within(scene).getByText("Worker VPS").parentElement).toHaveTextContent("Sẵn sàng");
  });

  it("preserves the selected project and local preview draft across surfaces", () => {
    render(
      <DashboardShell
        workerOnline
        drive={{ status: "CONNECTED", accountHint: null, rootReady: true }}
        health={health}
        projects={[{
          id: "10000000-0000-4000-8000-000000000001",
          status: "READY",
          name: "Video giữ preview",
          sourceStatus: "SOURCE_READY",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
        }]}
        jobs={[]}
        workers={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Tiếp tục thiết lập" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Theo dõi job" })).not.toBeInTheDocument();
    const draft = screen.getByLabelText("Nghe thử câu voice");
    fireEvent.change(draft, { target: { value: "Bản nghe thử chưa lưu" } });

    const nav = screen.getByRole("navigation", { name: "Điều hướng Zeus MMO" });
    fireEvent.click(within(nav).getByRole("button", { name: /Files/ }));
    fireEvent.click(within(nav).getByRole("button", { name: /Jobs/ }));
    expect(screen.getByRole("region", { name: "Danh sách job" })).toBeVisible();
    fireEvent.click(within(nav).getByRole("button", { name: /Workspace/ }));

    expect(screen.getByLabelText("Nghe thử câu voice")).toHaveValue("Bản nghe thử chưa lưu");
    expect(within(screen.getByLabelText("Project inspector")).getByText("Video giữ preview")).toBeVisible();
  });

  // A worker rendering the current job is attached and healthy; treating BUSY as
  // "no worker" hid the VPS for the whole render and blocked the next project.
  it("treats a BUSY worker as an attached worker", () => {
    render(
      <DashboardShell
        workerOnline={false}
        drive={{ status: "CONNECTED", accountHint: null, rootReady: true }}
        health={health}
        projects={[{
          id: "10000000-0000-4000-8000-000000000001",
          status: "READY",
          name: "Video đang render",
          sourceStatus: "SOURCE_READY",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
        }]}
        jobs={[]}
        workers={[{
          id: "20000000-0000-4000-8000-000000000001",
          state: "BUSY",
          accountLabel: null,
          capabilities: {
            protocolVersion: 1,
            pipelineBridgeVersion: "cp4-media-v1",
            os: "ubuntu-22.04",
            arch: "x86_64",
            gpuName: "NVIDIA GeForce RTX 3060",
            vramMiB: 12_288,
            cudaVersion: "12.4",
            nvenc: true,
          },
          doctor: { status: "PASS", reasonCodes: ["CUDA_AVAILABLE"], observedAt: "2026-07-19T00:00:00.000Z" },
          lastHeartbeatAt: "2026-07-19T00:00:00.000Z",
          sessionExpiresAt: "2026-07-20T00:00:00.000Z",
        }]}
      />,
    );

    const inspector = screen.getByLabelText("Project inspector");
    expect(within(inspector).getByText("Worker sẵn sàng")).toBeVisible();
    expect(within(inspector).queryByRole("button", { name: "Setup VPS để render" })).not.toBeInTheDocument();
  });

  it("keeps worker setup reachable when a source-ready video has no ready worker", () => {
    render(
      <DashboardShell
        workerOnline={false}
        drive={{ status: "CONNECTED", accountHint: null, rootReady: true }}
        health={health}
        projects={[{
          id: "10000000-0000-4000-8000-000000000001",
          status: "READY",
          name: "Video chờ VPS",
          sourceStatus: "SOURCE_READY",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
        }]}
        jobs={[]}
        workers={[]}
      />,
    );

    const inspector = screen.getByLabelText("Project inspector");
    expect(within(inspector).getByRole("button", { name: "Thiết lập & xem trước" })).toBeEnabled();
    fireEvent.click(within(inspector).getByRole("button", { name: "Setup VPS để render" }));

    expect(screen.getByRole("heading", { level: 1, name: "Workers" })).toBeVisible();
    expect(screen.getByRole("region", { name: "Gắn VPS" })).toBeVisible();
  });

  it("makes a project source-ready after an upload completes in Files", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const project = {
      id: "10000000-0000-4000-8000-000000000001",
      status: "READY" as const,
      name: "Phim thử nghiệm",
      sourceStatus: "NO_SOURCE" as const,
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z",
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url === "/api/v1/projects") {
        return new Response(JSON.stringify({ project }), { status: 201, headers: { "content-type": "application/json" } });
      }
      if (url === "/api/v1/drive/files") {
        return new Response(JSON.stringify({ input: [], output: [], processingCount: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === `/api/v1/projects/${project.id}/upload-session`) {
        return new Response(JSON.stringify({
          artifactId: project.id,
          sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
          chunkBytes: 8_388_608,
          // Must stay in the future relative to the real clock — upload-store rejects expired sessions.
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files/")) {
        return new Response(null, { status: 200 });
      }
      if (url === `/api/v1/projects/${project.id}/upload-complete`) {
        return new Response(JSON.stringify({ status: "SOURCE_READY", actualSizeBytes: 100 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("scene-settings")) {
        return new Response(JSON.stringify({ settings: null }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    const xhr = {
      abort: vi.fn(),
      getResponseHeader: vi.fn(() => null),
      onabort: null,
      onerror: null,
      onload: null,
      open: vi.fn(),
      send: vi.fn(),
      setRequestHeader: vi.fn(),
      status: 200,
    } as unknown as XMLHttpRequest;
    vi.mocked(xhr.send).mockImplementation(() => {
      xhr.onload?.(new ProgressEvent("load"));
    });
    vi.stubGlobal("XMLHttpRequest", vi.fn(function XMLHttpRequestMock() {
      return xhr;
    }));
    render(<DashboardShell workerOnline={false} drive={{ status: "CONNECTED", accountHint: null, rootReady: true }} health={health} projects={[]} jobs={[]} workers={[]} />);

    const nav = screen.getByRole("navigation", { name: "Điều hướng Zeus MMO" });
    fireEvent.click(within(nav).getByRole("button", { name: /Files/ }));
    const file = new File([new Uint8Array(100)], "Phim thử nghiệm.mp4", { type: "video/mp4", lastModified: 1 });
    fireEvent.change(screen.getByLabelText("Thêm video"), { target: { files: [file] } });

    // Upload completion selects the project and returns to Workspace with the scene editor mounted.
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Workspace" })).toBeVisible(), { timeout: 3_000 });
    expect(await screen.findByRole("region", { name: "Blur và voice" })).toBeVisible();
  });
});
