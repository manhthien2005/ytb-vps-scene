import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell", () => {
  it("shows the no-worker empty state and queued jobs", () => {
    render(
      <DashboardShell
        workerOnline={false}
        jobs={[
          {
            id: "j1",
            projectName: "Test 1",
            state: "QUEUED",
            progressPercent: 0,
            updatedAt: "2026-07-19T00:00:00Z",
          },
        ]}
      />,
    );
    expect(screen.getByText("Chưa gắn GPU VPS")).toBeInTheDocument();
    expect(screen.getByText("Test 1")).toBeInTheDocument();
    const attachButton = screen.getByRole("button", { name: "Gắn VPS" });
    expect(attachButton).toBeDisabled();
    expect(attachButton).toHaveAccessibleDescription(
      "Tính năng gắn VPS sẽ khả dụng ở giai đoạn sau.",
    );
    expect(screen.getByText("Tính năng gắn VPS sẽ khả dụng ở giai đoạn sau.")).toBeVisible();
  });
});
