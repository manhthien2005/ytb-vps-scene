import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardShell } from "./dashboard-shell";

const health = {
  mode: "READ_WRITE" as const,
  reasons: [],
  driveConnection: "CONNECTED" as const,
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};

describe("DashboardShell", () => {
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
    expect(screen.getByLabelText("Video nguồn")).toBeEnabled();
    const attachButton = screen.getByRole("button", { name: "Tạo lệnh gắn VPS" });
    expect(attachButton).toBeEnabled();
    expect(screen.getByText("Anh có thể tạo lệnh gắn VPS bất cứ lúc nào.")).toBeVisible();
  });
});
