import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopSurface } from "./types";

const mocks = vi.hoisted(() => ({
  moveDesktopItems: vi.fn(),
}));

vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client")>()),
  moveDesktopItems: mocks.moveDesktopItems,
}));

import { useDesktopSurfaceStore } from "./store";

const initial: DesktopSurface = {
  schemaVersion: 1,
  revision: 4,
  items: [
    {
      id: "11".repeat(16),
      target: { type: "app", handle: "system.files" },
      position: { x: 0, y: 0 },
      createdAtMs: 1,
      resolved: {
        available: true,
        name: "文件",
        kind: "app",
      },
    },
  ],
};

describe("desktop surface optimistic layout", () => {
  beforeEach(() => {
    mocks.moveDesktopItems.mockReset();
    useDesktopSurfaceStore.setState({
      status: "ready",
      surface: initial,
      selectedItemIds: new Set(),
      error: undefined,
    });
  });

  it("publishes the drop position before the server responds", async () => {
    let resolveRequest!: (surface: DesktopSurface) => void;
    mocks.moveDesktopItems.mockReturnValue(
      new Promise<DesktopSurface>((resolve) => {
        resolveRequest = resolve;
      }),
    );

    const operation = useDesktopSurfaceStore.getState().move([
      {
        itemId: initial.items[0].id,
        position: { x: 73, y: 41 },
      },
    ]);
    expect(
      useDesktopSurfaceStore.getState().surface.items[0].position,
    ).toEqual({ x: 73, y: 41 });

    const confirmed = {
      ...initial,
      revision: 5,
      items: [
        {
          ...initial.items[0],
          position: { x: 73, y: 41 },
        },
      ],
    };
    resolveRequest(confirmed);
    await operation;
    expect(useDesktopSurfaceStore.getState().surface).toEqual(confirmed);
  });

  it("rolls the whole layout back when persistence fails", async () => {
    mocks.moveDesktopItems.mockRejectedValue(new Error("network failed"));
    await expect(
      useDesktopSurfaceStore.getState().move([
        {
          itemId: initial.items[0].id,
          position: { x: 73, y: 41 },
        },
      ]),
    ).rejects.toThrow("network failed");
    expect(useDesktopSurfaceStore.getState().surface).toEqual(initial);
  });
});
