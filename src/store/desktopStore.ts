import { create } from "zustand";
import { DEFAULT_WALLPAPER } from "./defaults";
import type {
  AppDefinition,
  ConfigStatus,
  WindowState,
} from "../types/desktop";

interface DesktopState {
  apps: Record<string, AppDefinition>;
  configStatus: ConfigStatus;
  configError?: string;
  configWarnings: string[];
  pinnedAppIds: string[];
  pinnedInitialized: boolean;
  windows: Record<string, WindowState>;
  activeAppId: string | null;
  wallpaper: string;
  selectedDesktopAppId: string | null;
  appMenuOpen: boolean;
  setApps: (apps: AppDefinition[]) => void;
  setConfigState: (
    status: ConfigStatus,
    warnings?: string[],
    error?: string,
  ) => void;
  initializePinnedApps: (appIds: string[]) => void;
  pinApp: (appId: string) => void;
  unpinApp: (appId: string) => void;
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
  configStatus: "loading",
  configError: undefined,
  configWarnings: [],
  pinnedAppIds: [],
  pinnedInitialized: false,
  windows: {},
  activeAppId: null,
  wallpaper: DEFAULT_WALLPAPER,
  selectedDesktopAppId: null,
  appMenuOpen: false,
  setApps: (apps) =>
    set({
      apps: Object.fromEntries(apps.map((app) => [app.id, app])),
    }),
  setConfigState: (configStatus, configWarnings = [], configError) =>
    set({ configStatus, configWarnings, configError }),
  initializePinnedApps: (appIds) =>
    set((state) =>
      state.pinnedInitialized
        ? state
        : {
            pinnedAppIds: [...new Set(appIds)],
            pinnedInitialized: true,
          },
    ),
  pinApp: (appId) =>
    set((state) => ({
      pinnedAppIds: state.pinnedAppIds.includes(appId)
        ? state.pinnedAppIds
        : [...state.pinnedAppIds, appId],
      pinnedInitialized: true,
    })),
  unpinApp: (appId) =>
    set((state) => ({
      pinnedAppIds: state.pinnedAppIds.filter((id) => id !== appId),
      pinnedInitialized: true,
    })),
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
