import { describe, expect, it } from "vitest";
import type { DesktopItem } from "../desktopSurface/types";
import {
  autoAlignDesktopItems,
  findGroupPlacement,
} from "../desktopSurface/layout";

function item(
  id: string,
  x: number,
  y: number,
): DesktopItem {
  return {
    id,
    target: { type: "app", handle: `example.${id}` },
    position: { x, y },
    createdAtMs: 1,
    resolved: {
      available: true,
      name: id,
      kind: "app",
    },
  };
}

describe("desktop group placement", () => {
  it("keeps the selected group shape", () => {
    const items = [item("a", 0, 0), item("b", 106, 0)];
    expect(
      findGroupPlacement(items, new Set(["a", "b"]), 20, 30),
    ).toEqual([
      { itemId: "a", position: { x: 20, y: 30 } },
      { itemId: "b", position: { x: 126, y: 30 } },
    ]);
  });

  it("moves the whole group to the nearest collision-free delta", () => {
    const items = [
      item("a", 0, 0),
      item("b", 106, 0),
      item("occupied", 212, 0),
    ];
    const result = findGroupPlacement(
      items,
      new Set(["a", "b"]),
      106,
      0,
    );
    expect(result).toBeDefined();
    const [first, second] = result!;
    expect(second.position.x - first.position.x).toBe(106);
    expect(second.position.y - first.position.y).toBe(0);
    expect(
      result?.some(
        ({ position }) =>
          position.x === 212 && position.y === 0,
      ),
    ).toBe(false);
  });

  it("does not place any member outside the non-negative grid", () => {
    const items = [item("a", 0, 0), item("b", 0, 112)];
    const result = findGroupPlacement(
      items,
      new Set(["a", "b"]),
      -20,
      -20,
    );
    expect(
      result?.every(
        ({ position }) => position.x >= 0 && position.y >= 0,
      ),
    ).toBe(true);
  });

  it("aligns each item to a nearby unique grid position", () => {
    const items = [item("a", 96, 8), item("b", 118, 14)];
    expect(
      autoAlignDesktopItems(items, { maxX: 400, maxY: 300 }),
    ).toEqual([
      { itemId: "a", position: { x: 106, y: 0 } },
      { itemId: "b", position: { x: 212, y: 0 } },
    ]);
  });
});
