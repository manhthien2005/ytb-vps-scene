import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DriveCard } from "./drive-card";
import type { FreeTierHealthView } from "./dashboard-types";

const HEALTHY: FreeTierHealthView = {
  mode: "READ_WRITE",
  reasons: [],
  driveConnection: "CONNECTED",
  drive: { usedBytes: 100, limitBytes: 1_000, appManagedBytes: 20, observedAt: "2026-07-19T00:00:00.000Z" },
  neon: { usedBytes: 10, limitBytes: 1_000, appManagedBytes: 0, observedAt: "2026-07-19T00:00:00.000Z" },
};

describe("DriveCard", () => {
  it("shows the connect action while disconnected", () => {
    render(<DriveCard value={{ status: "DISCONNECTED", accountHint: null, rootReady: false }} health={{ ...HEALTHY, driveConnection: "DISCONNECTED" }} />);
    expect(screen.getByRole("button", { name: "Kết nối Google Drive" })).toBeEnabled();
    expect(screen.getByText("Chưa kết nối")).toBeVisible();
  });

  it("starts OAuth only through the validated Google URL", async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    render(<DriveCard value={{ status: "DISCONNECTED", accountHint: null, rootReady: false }} health={{ ...HEALTHY, driveConnection: "DISCONNECTED" }} fetcher={fetcher} navigate={navigate} />);

    fireEvent.click(screen.getByRole("button", { name: "Kết nối Google Drive" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith("/api/v1/drive/connect", expect.objectContaining({ method: "POST" }));
  });

  it("shows the masked connected account and disconnect action", () => {
    render(<DriveCard value={{ status: "CONNECTED", accountHint: "a***@example.test", rootReady: true }} health={HEALTHY} />);
    expect(screen.getByText("Đã kết nối")).toBeVisible();
    expect(screen.getByText("a***@example.test")).toBeVisible();
    expect(screen.getByRole("button", { name: "Ngắt kết nối" })).toBeEnabled();
  });
});
