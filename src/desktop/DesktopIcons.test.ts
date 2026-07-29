import { describe, expect, it } from "vitest";
import type { DesktopItem } from "../desktopSurface/types";
import { findGroupPlacement } from "../desktopSurface/layout";

function item(
  id: string,
  column: number,
  row: number,
): DesktopItem {
  return {
    id,
    target: { type: "app", handle: `example.${id}` },
    position: { column, row },
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
    const items = [item("a", 0, 0), item("b", 1, 0)];
    expect(
      findGroupPlacement(items, new Set(["a", "b"]), 2, 3),
    ).toEqual([
      { itemId: "a", position: { column: 2, row: 3 } },
      { itemId: "b", position: { column: 3, row: 3 } },
    ]);
  });

  it("moves the whole group to the nearest collision-free delta", () => {
    const items = [
      item("a", 0, 0),
      item("b", 1, 0),
      item("occupied", 2, 0),
    ];
    const result = findGroupPlacement(
      items,
      new Set(["a", "b"]),
      1,
      0,
    );
    expect(result).toBeDefined();
    const [first, second] = result!;
    expect(
      second.position.column - first.position.column,
    ).toBe(1);
    expect(second.position.row - first.position.row).toBe(0);
    expect(
      result?.some(
        ({ position }) =>
          position.column === 2 && position.row === 0,
      ),
    ).toBe(false);
  });

  it("does not place any member outside the non-negative grid", () => {
    const items = [item("a", 0, 0), item("b", 0, 1)];
    const result = findGroupPlacement(
      items,
      new Set(["a", "b"]),
      -4,
      -4,
    );
    expect(
      result?.every(
        ({ position }) => position.column >= 0 && position.row >= 0,
      ),
    ).toBe(true);
  });
});
