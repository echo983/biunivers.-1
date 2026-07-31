import { create } from "zustand";
import { DEFAULT_WALLPAPER } from "./defaults";
import type {
  AppDefinition,
  ConfigStatus,
  DefaultResourceHandler,
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
  runningAppIds: string[];
  activeAppId: string | null;
  wallpaper: string;
  defaultResourceHandlers: Record<string, DefaultResourceHandler>;
  selectedDesktopAppId: string | null;
  appMenuOpen: boolean;
  setApps: (apps: AppDefinition[]) => void;
  registerRuntimeApp: (app: AppDefinition) => void;
  setConfigState: (
    status: ConfigStatus,
    warnings?: string[],
    error?: string,
  ) => void;
  initializePinnedApps: (appIds: string[]) => void;
  pinApp: (appId: string) => void;
  unpinApp: (appId: string) => void;
  resetPinnedApps: (appIds: string[]) => void;
  addWindow: (window: WindowState) => void;
  removeWindow: (appId: string) => void;
  setActiveApp: (appId: string | null) => void;
  updateWindow: (appId: string, update: Partial<WindowState>) => void;
  setWallpaper: (wallpaper: string) => void;
  setDefaultResourceHandler: (
    key: string,
    handler: DefaultResourceHandler,
  ) => void;
  clearDefaultResourceHandler: (key: string) => void;
  hydrateDesktop: (state: {
    wallpaper: string;
    pinnedAppIds: string[];
    windows: Record<string, WindowState>;
    runningAppIds: string[];
    activeAppId: string | null;
    defaultResourceHandlers: Record<string, DefaultResourceHandler>;
  }) => void;
  clearWindowState: () => void;
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
  runningAppIds: [],
  activeAppId: null,
  wallpaper: DEFAULT_WALLPAPER,
  defaultResourceHandlers: {},
  selectedDesktopAppId: null,
  appMenuOpen: false,
  setApps: (apps) =>
    set((state) => ({
      apps: {
        ...Object.fromEntries(
          Object.values(state.apps)
            .filter((app) => app.transient)
            .map((app) => [app.id, app]),
        ),
        ...Object.fromEntries(apps.map((app) => [app.id, app])),
      },
    })),
  registerRuntimeApp: (app) =>
    set((state) => ({ apps: { ...state.apps, [app.id]: app } })),
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
  resetPinnedApps: (appIds) =>
    set({
      pinnedAppIds: [...new Set(appIds)],
      pinnedInitialized: true,
    }),
  addWindow: (window) =>
    set((state) => ({
      windows: { ...state.windows, [window.appId]: window },
      runningAppIds: state.runningAppIds.includes(window.appId)
        ? state.runningAppIds
        : [...state.runningAppIds, window.appId],
    })),
  removeWindow: (appId) =>
    set((state) => {
      const current = state.windows[appId];
      return {
        windows: current
          ? {
              ...state.windows,
              [appId]: {
                ...current,
                hidden: false,
                maximized: false,
                active: false,
              },
            }
          : state.windows,
        runningAppIds: state.runningAppIds.filter((id) => id !== appId),
        activeAppId:
          state.activeAppId === appId ? null : state.activeAppId,
      };
    }),
  setWallpaper: (wallpaper) => set({ wallpaper }),
  setDefaultResourceHandler: (key, handler) =>
    set((state) => ({
      defaultResourceHandlers: {
        ...state.defaultResourceHandlers,
        [key]: handler,
      },
    })),
  clearDefaultResourceHandler: (key) =>
    set((state) => ({
      defaultResourceHandlers: Object.fromEntries(
        Object.entries(state.defaultResourceHandlers).filter(
          ([candidateKey]) => candidateKey !== key,
        ),
      ),
    })),
  hydrateDesktop: (desktop) =>
    set({
      ...desktop,
      pinnedInitialized: true,
    }),
  clearWindowState: () =>
    set({
      windows: {},
      runningAppIds: [],
      activeAppId: null,
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
