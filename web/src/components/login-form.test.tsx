import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoginForm } from "./login-form";

describe("LoginForm", () => {
  it("submits the key without placing it in a URL", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true });
    const onSuccess = vi.fn();
    render(<LoginForm fetcher={fetcher} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText("Admin key"), {
      target: { value: "private-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mở bảng điều khiển" }));
    await waitFor(() =>
      expect(fetcher).toHaveBeenCalledWith(
        "/api/v1/auth/login",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("private-value");
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Mở bảng điều khiển" })).toBeEnabled();
  });

  it("recovers after a rejected login request", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ ok: true });
    const onSuccess = vi.fn();
    render(<LoginForm fetcher={fetcher} onSuccess={onSuccess} />);
    fireEvent.change(screen.getByLabelText("Admin key"), {
      target: { value: "private-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mở bảng điều khiển" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Admin key không đúng hoặc yêu cầu bị từ chối.",
    );
    const retryButton = screen.getByRole("button", { name: "Mở bảng điều khiển" });
    expect(retryButton).toBeEnabled();

    fireEvent.click(retryButton);
    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
