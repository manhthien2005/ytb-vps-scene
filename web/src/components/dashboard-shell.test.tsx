import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardShell } from "./dashboard-shell";

const health = {
  mode: "READ_WRITE" as const,
  reasons: [],
  driveConnection: "CONNECTED" as const,
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};

describe("DashboardShell", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the four-step workflow and readiness summary", () => {
    render(<DashboardShell workerOnline={false} drive={{ status: "CONNECTED", accountHint: null, rootReady: true }} health={health} projects={[]} jobs={[]} workers={[]} />);
    expect(screen.getByRole("navigation", { name: "Quy trình render" })).toBeVisible();
    expect(screen.getByRole("button", { name: /1\. Drive/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /2\. VPS/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /3\. Review/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /4\. Render/ })).toBeVisible();
    expect(screen.getByText("Nguồn: Chưa có")).toBeVisible();
    expect(screen.getByText("VPS: Chưa gắn")).toBeVisible();
  });

  it("shows the no-worker empty state and queued jobs", () => {
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
          {
            id: "j1",
            projectName: "Test 1",
            state: "QUEUED",
            progressPercent: 0,
            updatedAt: "2026-07-19T00:00:00Z",
          },
        ]}
        workers={[]}
      />,
    );
    expect(screen.getByText("Chưa gắn GPU VPS")).toBeInTheDocument();
    expect(screen.getByText("Test 1")).toBeInTheDocument();
    expect(screen.getByText("Đã kết nối")).toBeVisible();
    expect(screen.getByLabelText("File video")).toBeEnabled();
    const attachButton = screen.getByRole("button", { name: "Tạo lệnh gắn VPS" });
    expect(attachButton).toBeEnabled();
    expect(screen.getByText("Anh có thể tạo lệnh gắn VPS bất cứ lúc nào.")).toBeVisible();
  });

  it("unlocks Review as soon as a video upload becomes ready", async () => {
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
        return new Response(JSON.stringify({ project }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === `/api/v1/projects/${project.id}/upload-session`) {
        return new Response(JSON.stringify({
          artifactId: project.id,
          sessionUri: "https://www.googleapis.com/upload/drive/v3/files/source?upload_id=synthetic-capability",
          chunkBytes: 8_388_608,
          expiresAt: "2026-07-26T00:00:00.000Z",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files/")) {
        return new Response(null, { status: 200 });
      }
      if (url === `/api/v1/projects/${project.id}/upload-complete`) {
        return new Response(JSON.stringify({ status: "SOURCE_READY", actualSizeBytes: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<DashboardShell workerOnline={false} drive={{ status: "CONNECTED", accountHint: null, rootReady: true }} health={health} projects={[]} jobs={[]} workers={[]} />);
    const file = new File([new Uint8Array(100)], "Phim thử nghiệm.mp4", { type: "video/mp4", lastModified: 1 });

    fireEvent.change(screen.getByLabelText("File video"), { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: "Tải video lên" }));

    await waitFor(() => expect(screen.getByRole("button", { name: /3\. Review/ })).toBeEnabled());
    expect(screen.getByText("Nguồn: Sẵn sàng")).toBeVisible();
  });
});
