import type { DesktopItem, DesktopPosition } from "./types";

export function findGroupPlacement(
  items: DesktopItem[],
  selectedIds: Set<string>,
  requestedColumnDelta: number,
  requestedRowDelta: number,
  bounds?: { maxColumn: number; maxRow: number },
): Array<{ itemId: string; position: DesktopPosition }> | undefined {
  const selected = items.filter((item) => selectedIds.has(item.id));
  const occupied = new Set(
    items
      .filter((item) => !selectedIds.has(item.id))
      .map(({ position }) => `${position.column}:${position.row}`),
  );
  for (let distance = 0; distance <= 24; distance += 1) {
    for (let x = -distance; x <= distance; x += 1) {
      const yDistance = distance - Math.abs(x);
      for (const y of new Set([yDistance, -yDistance])) {
        const columnDelta = requestedColumnDelta + x;
        const rowDelta = requestedRowDelta + y;
        const moves = selected.map((item) => ({
          itemId: item.id,
          position: {
            column: item.position.column + columnDelta,
            row: item.position.row + rowDelta,
          },
        }));
        if (
          moves.every(
            ({ position }) =>
              position.column >= 0 &&
              position.row >= 0 &&
              (!bounds ||
                (position.column <= bounds.maxColumn &&
                  position.row <= bounds.maxRow)) &&
              !occupied.has(`${position.column}:${position.row}`),
          )
        ) {
          return moves;
        }
      }
    }
  }
  return undefined;
}
