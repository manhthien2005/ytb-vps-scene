import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkerCard } from "./worker-card";

const worker = {
  id: "10000000-0000-4000-8000-000000000001",
  state: "READY" as const,
  accountLabel: null,
  capabilities: { protocolVersion: 1 as const, pipelineBridgeVersion: "cp3-control-only", os: "ubuntu-22.04" as const, arch: "x86_64" as const, gpuName: "RTX", vramMiB: 12288, cudaVersion: "12.4", nvenc: true },
  doctor: { status: "PASS" as const, reasonCodes: [], observedAt: "2026-07-20T08:30:00.000Z" },
  lastHeartbeatAt: "2026-07-20T08:30:00.000Z",
  sessionExpiresAt: "2026-07-21T08:30:00.000Z",
};

describe("WorkerCard", () => {
  it("creates one expiring install command and copies it without exposing a session field", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ command: "curl -fsSL https://example.test/bootstrap-worker.sh", expiresAt: "2026-07-20T08:40:00.000Z" }), { status: 200 }));
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    render(<WorkerCard workers={[]} fetcher={fetcher} clipboard={clipboard} />);
    fireEvent.click(screen.getByRole("button", { name: "Tạo lệnh gắn VPS" }));
    expect(await screen.findByText(/Lệnh hết hạn/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Sao chép lệnh" }));
    expect(clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^curl -fsSL https:\/\//));
    expect(document.body.textContent).not.toContain("sessionSecret");
  });

  it("shows control-only setup honestly and never calls it render-ready", () => {
    render(<WorkerCard workers={[worker]} />);
    expect(screen.getByText("Đã kết nối · đang chờ cài pipeline media")).toBeVisible();
    expect(screen.queryByText("Sẵn sàng render")).not.toBeInTheDocument();
  });
});
