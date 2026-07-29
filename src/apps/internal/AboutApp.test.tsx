import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AboutApp } from "./AboutApp";

describe("AboutApp", () => {
  it("shows the current milestone and delivered capabilities", () => {
    render(<AboutApp />);

    expect(
      screen.getByRole("heading", { name: "Biunivers 桌面" }),
    ).toBeVisible();
    expect(screen.getByText("版本 0.9.0")).toBeVisible();
    expect(
      screen.getByText("File Service · Resource Session v1"),
    ).toBeVisible();
    expect(
      screen.getByText("Biunivers Static App Protocol v1"),
    ).toBeVisible();
  });
});
