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

  it("sends SSH credentials only to the local connector", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ command: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'", expiresAt: "2026-07-20T08:40:00.000Z" }), { status: 200 }));
    const connectorFetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 }))
      .mockResolvedValueOnce(new Response("event: progress\ndata: {\"stage\":\"READY\",\"percent\":100,\"message\":\"VPS đã sẵn sàng để render.\"}\n\n", { status: 200 }));
    const onWorkerChange = vi.fn();
    render(<WorkerCard workers={[]} fetcher={fetcher} connectorFetcher={connectorFetcher} onWorkerChange={onWorkerChange} />);
    fireEvent.change(screen.getByLabelText("SSH command"), { target: { value: "ssh root@n1.ckey.vn -p 1210" } });
    fireEvent.change(screen.getByLabelText("Mật khẩu VPS"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Kết nối và setup VPS" }));
    expect(await screen.findByText("VPS đã sẵn sàng để render.")).toBeVisible();
    expect(onWorkerChange).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(connectorFetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:55871/setup", expect.objectContaining({ method: "POST", body: expect.stringContaining("secret-password") }));
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it("renders intermediate setup stages as they stream in, not just the final one", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ command: "curl -fsSL https://raw.githubusercontent.com/acme/repo/abc/ops/native-v2/bootstrap-worker.sh | sudo bash -s -- 'https://app.example' 'token' 'https://github.com/acme/repo.git' 'abc'", expiresAt: "2026-07-20T09:00:00.000Z" }), { status: 200 }));
    const encoder = new TextEncoder();
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const connectorFetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ jobId: "job-1" }), { status: 202 }))
      .mockResolvedValueOnce(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const onWorkerChange = vi.fn();
    render(<WorkerCard workers={[]} fetcher={fetcher} connectorFetcher={connectorFetcher} onWorkerChange={onWorkerChange} />);
    fireEvent.change(screen.getByLabelText("SSH command"), { target: { value: "ssh root@n1.ckey.vn -p 1210" } });
    fireEvent.change(screen.getByLabelText("Mật khẩu VPS"), { target: { value: "secret-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Kết nối và setup VPS" }));

    controller!.enqueue(encoder.encode("event: progress\ndata: {\"stage\":\"INSTALLING\",\"percent\":35,\"message\":\"Đang cài thành phần render…\"}\n\n"));
    expect(await screen.findByText("INSTALLING · 35%")).toBeVisible();
    expect(onWorkerChange).not.toHaveBeenCalled();

    controller!.enqueue(encoder.encode("event: progress\ndata: {\"stage\":\"READY\",\"percent\":100,\"message\":\"VPS đã sẵn sàng để render.\"}\n\n"));
    controller!.close();
    expect(await screen.findByText("READY · 100%")).toBeVisible();
    expect(onWorkerChange).toHaveBeenCalledTimes(1);
  });
});
