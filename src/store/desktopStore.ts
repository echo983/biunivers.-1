import { create } from "zustand";
import { DEFAULT_WALLPAPER } from "./defaults";
import type { AppDefinition, WindowState } from "../types/desktop";

interface DesktopState {
  apps: Record<string, AppDefinition>;
  windows: Record<string, WindowState>;
  activeAppId: string | null;
  wallpaper: string;
  selectedDesktopAppId: string | null;
  appMenuOpen: boolean;
  setApps: (apps: AppDefinition[]) => void;
  addWindow: (window: WindowState) => void;
  removeWindow: (appId: string) => void;
  setActiveApp: (appId: string | null) => void;
  updateWindow: (appId: string, update: Partial<WindowState>) => void;
  selectDesktopApp: (appId: string | null) => void;
  openAppMenu: () => void;
  closeAppMenu: () => void;
  toggleAppMenu: () => void;
}

export const useDesktopStore = create<DesktopState>((set) => ({
  apps: {},
  windows: {},
  activeAppId: null,
  wallpaper: DEFAULT_WALLPAPER,
  selectedDesktopAppId: null,
  appMenuOpen: false,
  setApps: (apps) =>
    set({
      apps: Object.fromEntries(apps.map((app) => [app.id, app])),
    }),
  addWindow: (window) =>
    set((state) => ({
      windows: { ...state.windows, [window.appId]: window },
    })),
  removeWindow: (appId) =>
    set((state) => {
      const windows = { ...state.windows };
      delete windows[appId];
      return {
        windows,
        activeAppId:
          state.activeAppId === appId ? null : state.activeAppId,
      };
    }),
  setActiveApp: (appId) =>
    set((state) => ({
      activeAppId: appId,
      windows: Object.fromEntries(
        Object.entries(state.windows).map(([id, window]) => [
          id,
          { ...window, active: id === appId },
        ]),
      ),
    })),
  updateWindow: (appId, update) =>
    set((state) => {
      const current = state.windows[appId];
      if (!current) {
        return state;
      }
      return {
        windows: {
          ...state.windows,
          [appId]: { ...current, ...update, appId },
        },
      };
    }),
  selectDesktopApp: (appId) => set({ selectedDesktopAppId: appId }),
  openAppMenu: () => set({ appMenuOpen: true }),
  closeAppMenu: () => set({ appMenuOpen: false }),
  toggleAppMenu: () => set((state) => ({ appMenuOpen: !state.appMenuOpen })),
}));
