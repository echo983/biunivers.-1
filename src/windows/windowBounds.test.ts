import { describe, expect, it } from "vitest";
import { defaultApps } from "../store/defaults";
import { clampWindowBounds, getInitialWindowBounds } from "./windowBounds";

describe("window bounds", () => {
  it("centers and limits a new window to the available viewport", () => {
    const bounds = getInitialWindowBounds(
      {
        ...defaultApps[0],
        defaultWidth: 1100,
        defaultHeight: 720,
        minWidth: 700,
        minHeight: 450,
      },
      {
      width: 900,
      height: 600,
      },
    );

    expect(bounds).toEqual({
      x: 0,
      y: 0,
      width: 900,
      height: 600,
    });
  });

  it("brings an off-screen window back into view", () => {
    const bounds = clampWindowBounds(
      { x: 2000, y: -40, width: 1200, height: 900 },
      { width: 1000, height: 700 },
    );

    expect(bounds).toEqual({
      x: 880,
      y: 0,
      width: 1000,
      height: 700,
    });
  });
});
