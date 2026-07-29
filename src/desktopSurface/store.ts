import { create } from "zustand";
import {
  DesktopSurfaceClientError,
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
import {
  DESKTOP_ITEM_HEIGHT,
  DESKTOP_ITEM_WIDTH,
  findFirstFreeGridPosition,
} from "./layout";

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
  patchResolvedTarget: (
    target: DesktopTarget,
    resolved: Partial<DesktopSurface["items"][number]["resolved"]>,
  ) => void;
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
      const positions = new Map(
        moves.map((move) => [move.itemId, move.position]),
      );
      set({
        error: undefined,
        surface: {
          ...surface,
          items: surface.items.map((item) => ({
            ...item,
            position: positions.get(item.id) ?? item.position,
          })),
        },
      });
      try {
        set({
          status: "ready",
          surface: await moveDesktopItems(moves, surface.revision),
        });
      } catch (error) {
        if (
          error instanceof DesktopSurfaceClientError &&
          error.code === "DESKTOP_SURFACE_CONFLICT"
        ) {
          try {
            set({
              status: "ready",
              surface: await readDesktopSurface(),
              error: "桌面已在其他页面中发生变化，请重新操作。",
            });
          } catch {
            set({
              status: "error",
              surface,
              error: messageOf(error),
            });
          }
        } else {
          set({
            status: "error",
            surface,
            error: messageOf(error),
          });
        }
        throw error;
      }
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
    patchResolvedTarget: (target, resolved) =>
      set((state) => ({
        surface: {
          ...state.surface,
          items: state.surface.items.map((item) =>
            item.target.type === target.type &&
            item.target.handle === target.handle
              ? {
                  ...item,
                  resolved: { ...item.resolved, ...resolved },
                }
              : item,
          ),
        },
      })),
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
    if (
      error instanceof DesktopSurfaceClientError &&
      error.code === "DESKTOP_SURFACE_CONFLICT"
    ) {
      try {
        set({
          status: "ready",
          surface: await readDesktopSurface(),
          error: "桌面已在其他页面中发生变化，请重新操作。",
        });
      } catch {
        set({ status: "error", error: messageOf(error) });
      }
      throw error;
    }
    set({ status: "error", error: messageOf(error) });
    throw error;
  }
}

function firstFreePosition(surface: DesktopSurface): DesktopPosition {
  return findFirstFreeGridPosition(surface.items, {
    maxX: Math.max(0, window.innerWidth - DESKTOP_ITEM_WIDTH - 20),
    maxY: Math.max(
      0,
      window.innerHeight - 48 - DESKTOP_ITEM_HEIGHT - 28,
    ),
  });
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : "桌面项目操作失败";
}
