import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import HomePage from "./page";

describe("HomePage", () => {
  it("explains that a GPU worker can be attached on demand", () => {
    render(<HomePage />);
    expect(screen.getByRole("heading", { name: "YTB VPS Studio" })).toBeInTheDocument();
    expect(screen.getByText("Chưa gắn GPU VPS")).toBeInTheDocument();
  });
});
