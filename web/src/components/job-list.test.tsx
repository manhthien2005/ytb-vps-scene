import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobList } from "./job-list";

describe("JobList", () => {
  it("only offers queue for a source-ready project", () => {
    render(<JobList jobs={[]} projects={[{ id: "10000000-0000-4000-8000-000000000001", status: "READY", name: "Ready", sourceStatus: "SOURCE_READY", createdAt: "2026-07-20T08:30:00.000Z", updatedAt: "2026-07-20T08:30:00.000Z" }, { id: "10000000-0000-4000-8000-000000000002", status: "READY", name: "Missing", sourceStatus: "NO_SOURCE", createdAt: "2026-07-20T08:30:00.000Z", updatedAt: "2026-07-20T08:30:00.000Z" }]} />);
    expect(screen.getByRole("button", { name: /Xếp “Ready”/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Missing/ })).not.toBeInTheDocument();
  });

  it("queues through the control-plane endpoint", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    render(<JobList jobs={[]} projects={[{ id: "10000000-0000-4000-8000-000000000001", status: "READY", name: "Ready", sourceStatus: "SOURCE_READY", createdAt: "2026-07-20T08:30:00.000Z", updatedAt: "2026-07-20T08:30:00.000Z" }]} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: /Xếp “Ready”/ }));
    expect(await screen.findByText("Đã xếp job vào hàng đợi.")).toBeVisible();
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/api/v1/projects/10000000-0000-4000-8000-000000000001/jobs"), expect.objectContaining({ method: "POST" }));
  });

  it("suppresses repeated queue clicks while the project request is pending", async () => {
    let resolveQueue: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      resolveQueue = resolve;
    }));
    render(<JobList jobs={[]} projects={[{ id: "10000000-0000-4000-8000-000000000001", status: "READY", name: "Ready", sourceStatus: "SOURCE_READY", createdAt: "2026-07-20T08:30:00.000Z", updatedAt: "2026-07-20T08:30:00.000Z" }]} fetcher={fetcher} />);
    const queueButton = screen.getByRole("button", { name: /Xếp “Ready”/ });

    fireEvent.click(queueButton);
    expect(queueButton).toBeDisabled();
    fireEvent.click(queueButton);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => resolveQueue?.(new Response("{}", { status: 201 })));
    expect(await screen.findByText("Đã xếp job vào hàng đợi.")).toBeVisible();
    expect(queueButton).toBeEnabled();
  });

  it("reports a rejected queue request and releases the project lock for retry", async () => {
    let rejectQueue: ((error: Error) => void) | undefined;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
        rejectQueue = reject;
      }))
      .mockResolvedValueOnce(new Response("{}", { status: 201 }));
    render(<JobList jobs={[]} projects={[{ id: "10000000-0000-4000-8000-000000000001", status: "READY", name: "Ready", sourceStatus: "SOURCE_READY", createdAt: "2026-07-20T08:30:00.000Z", updatedAt: "2026-07-20T08:30:00.000Z" }]} fetcher={fetcher} />);
    const queueButton = screen.getByRole("button", { name: /Xếp “Ready”/ });

    fireEvent.click(queueButton);
    expect(queueButton).toBeDisabled();
    await act(async () => rejectQueue?.(new Error("network unavailable")));

    expect(await screen.findByText("Chưa thể xếp job. Vui lòng thử lại.")).toBeVisible();
    expect(queueButton).toBeEnabled();

    fireEvent.click(queueButton);
    expect(await screen.findByText("Đã xếp job vào hàng đợi.")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
