import type { DesktopItem, DesktopPosition } from "./types";

export const DESKTOP_ITEM_WIDTH = 84;
export const DESKTOP_ITEM_HEIGHT = 106;
export const DESKTOP_GRID_X = 106;
export const DESKTOP_GRID_Y = 112;
const ITEM_GAP = 4;
const MAX_COLLISION_SEARCH = 160;

export interface DesktopBounds {
  maxX: number;
  maxY: number;
}

export function findGroupPlacement(
  items: DesktopItem[],
  selectedIds: Set<string>,
  requestedXDelta: number,
  requestedYDelta: number,
  bounds?: DesktopBounds,
): Array<{ itemId: string; position: DesktopPosition }> | undefined {
  const selected = items.filter((item) => selectedIds.has(item.id));
  const stationary = items.filter((item) => !selectedIds.has(item.id));
  for (let distance = 0; distance <= MAX_COLLISION_SEARCH; distance += 1) {
    for (const adjustment of perimeter(distance)) {
      const xDelta = Math.round(requestedXDelta + adjustment.x);
      const yDelta = Math.round(requestedYDelta + adjustment.y);
      const moves = selected.map((item) => ({
        itemId: item.id,
        position: {
          x: item.position.x + xDelta,
          y: item.position.y + yDelta,
        },
      }));
      if (
        moves.every(
          ({ position }) =>
            withinBounds(position, bounds) &&
            stationary.every(
              (item) => !positionsOverlap(position, item.position),
            ),
        )
      ) {
        return moves;
      }
    }
  }
  return undefined;
}

export function autoAlignDesktopItems(
  items: DesktopItem[],
  bounds: DesktopBounds,
): Array<{ itemId: string; position: DesktopPosition }> {
  const grid = visibleGrid(bounds);
  if (grid.length < items.length) {
    throw new Error("当前桌面没有足够的自动对齐位置");
  }
  const available = new Map(
    grid.map((position) => [positionKey(position), position]),
  );
  const ordered = [...items].sort(
    (left, right) =>
      left.position.y - right.position.y ||
      left.position.x - right.position.x ||
      left.createdAtMs - right.createdAtMs ||
      left.id.localeCompare(right.id),
  );
  const result: Array<{ itemId: string; position: DesktopPosition }> = [];
  for (const item of ordered) {
    const position = [...available.values()].sort((left, right) =>
      compareGridCandidate(item.position, left, right),
    )[0];
    available.delete(positionKey(position));
    result.push({ itemId: item.id, position });
  }
  return result;
}

export function findFirstFreeGridPosition(
  items: DesktopItem[],
  bounds: DesktopBounds,
): DesktopPosition {
  const position = visibleGrid(bounds).find((candidate) =>
    items.every((item) => !positionsOverlap(candidate, item.position)),
  );
  if (!position) throw new Error("桌面没有可用位置");
  return position;
}

function visibleGrid(bounds: DesktopBounds) {
  const positions: DesktopPosition[] = [];
  for (let x = 0; x <= bounds.maxX; x += DESKTOP_GRID_X) {
    for (let y = 0; y <= bounds.maxY; y += DESKTOP_GRID_Y) {
      positions.push({ x, y });
    }
  }
  return positions;
}

function compareGridCandidate(
  origin: DesktopPosition,
  left: DesktopPosition,
  right: DesktopPosition,
) {
  const leftX = left.x - origin.x;
  const leftY = left.y - origin.y;
  const rightX = right.x - origin.x;
  const rightY = right.y - origin.y;
  return (
    leftX * leftX +
    leftY * leftY -
    (rightX * rightX + rightY * rightY) ||
    directionRank(leftX, leftY) - directionRank(rightX, rightY) ||
    left.y - right.y ||
    left.x - right.x
  );
}

function directionRank(x: number, y: number) {
  if (y <= 0 && Math.abs(y) >= Math.abs(x)) return 0;
  if (x < 0 && Math.abs(x) > Math.abs(y)) return 1;
  if (x >= 0 && Math.abs(x) > Math.abs(y)) return 2;
  return 3;
}

function withinBounds(
  position: DesktopPosition,
  bounds: DesktopBounds | undefined,
) {
  return (
    position.x >= 0 &&
    position.y >= 0 &&
    (!bounds ||
      (position.x <= bounds.maxX && position.y <= bounds.maxY))
  );
}

function positionsOverlap(
  left: DesktopPosition,
  right: DesktopPosition,
) {
  return !(
    left.x + DESKTOP_ITEM_WIDTH + ITEM_GAP <= right.x ||
    right.x + DESKTOP_ITEM_WIDTH + ITEM_GAP <= left.x ||
    left.y + DESKTOP_ITEM_HEIGHT + ITEM_GAP <= right.y ||
    right.y + DESKTOP_ITEM_HEIGHT + ITEM_GAP <= left.y
  );
}

function perimeter(distance: number): DesktopPosition[] {
  if (distance === 0) return [{ x: 0, y: 0 }];
  const points: DesktopPosition[] = [];
  for (let x = -distance; x <= distance; x += 1) {
    const y = distance - Math.abs(x);
    points.push({ x, y: -y });
    if (y !== 0) points.push({ x, y });
  }
  return points;
}

function positionKey(position: DesktopPosition) {
  return `${position.x}:${position.y}`;
}
