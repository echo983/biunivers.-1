import { create } from "zustand";
import {
  addDesktopItem,
  moveDesktopItems,
  readDesktopSurface,
  removeDesktopItems,
  resetDesktopSurface,
} from "./client";
import type {
  DesktopPosition,
  DesktopSurface,
  DesktopTarget,
} from "./types";

interface DesktopSurfaceState {
  status: "idle" | "loading" | "ready" | "error";
  surface: DesktopSurface;
  selectedItemIds: Set<string>;
  error?: string;
  load: () => Promise<void>;
  add: (target: DesktopTarget, position?: DesktopPosition) => Promise<void>;
  move: (
    moves: Array<{ itemId: string; position: DesktopPosition }>,
  ) => Promise<void>;
  remove: (itemIds: string[]) => Promise<void>;
  reset: () => Promise<void>;
  setSelection: (itemIds: Iterable<string>) => void;
  toggleSelection: (itemId: string) => void;
  clearSelection: () => void;
}

const EMPTY_SURFACE: DesktopSurface = {
  schemaVersion: 1,
  revision: 0,
  items: [],
};

export const useDesktopSurfaceStore = create<DesktopSurfaceState>(
  (set, get) => ({
    status: "idle",
    surface: EMPTY_SURFACE,
    selectedItemIds: new Set(),
    error: undefined,
    load: async () => {
      set({ status: "loading", error: undefined });
      try {
        set({
          status: "ready",
          surface: await readDesktopSurface(),
          error: undefined,
        });
      } catch (error) {
        set({
          status: "error",
          error: messageOf(error),
        });
      }
    },
    add: async (target, requestedPosition) => {
      const { surface } = get();
      const position = requestedPosition ?? firstFreePosition(surface);
      await runMutation(set, () =>
        addDesktopItem(target, position, surface.revision),
      );
    },
    move: async (moves) => {
      const { surface } = get();
      await runMutation(set, () =>
        moveDesktopItems(moves, surface.revision),
      );
    },
    remove: async (itemIds) => {
      const { surface } = get();
      await runMutation(set, () =>
        removeDesktopItems(itemIds, surface.revision),
      );
      set((state) => ({
        selectedItemIds: new Set(
          [...state.selectedItemIds].filter((id) => !itemIds.includes(id)),
        ),
      }));
    },
    reset: async () => {
      const { surface } = get();
      await runMutation(set, () =>
        resetDesktopSurface(surface.revision),
      );
      set({ selectedItemIds: new Set() });
    },
    setSelection: (itemIds) =>
      set({ selectedItemIds: new Set(itemIds) }),
    toggleSelection: (itemId) =>
      set((state) => {
        const selectedItemIds = new Set(state.selectedItemIds);
        if (selectedItemIds.has(itemId)) selectedItemIds.delete(itemId);
        else selectedItemIds.add(itemId);
        return { selectedItemIds };
      }),
    clearSelection: () => set({ selectedItemIds: new Set() }),
  }),
);

async function runMutation(
  set: (
    partial:
      | Partial<DesktopSurfaceState>
      | ((
          state: DesktopSurfaceState,
        ) => Partial<DesktopSurfaceState>),
  ) => void,
  operation: () => Promise<DesktopSurface>,
) {
  set({ error: undefined });
  try {
    set({ status: "ready", surface: await operation() });
  } catch (error) {
    set({ status: "error", error: messageOf(error) });
    throw error;
  }
}

function firstFreePosition(surface: DesktopSurface): DesktopPosition {
  const occupied = new Set(
    surface.items.map(
      ({ position }) => `${position.column}:${position.row}`,
    ),
  );
  for (let column = 0; column < 1000; column += 1) {
    for (let row = 0; row < 1000; row += 1) {
      if (!occupied.has(`${column}:${row}`)) return { column, row };
    }
  }
  throw new Error("桌面没有可用位置");
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "桌面项目操作失败";
}
