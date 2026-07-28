import { create } from "zustand";
import { DEFAULT_WALLPAPER } from "./defaults";
import type { AppDefinition } from "../types/desktop";

interface DesktopState {
  apps: Record<string, AppDefinition>;
  wallpaper: string;
  selectedDesktopAppId: string | null;
  appMenuOpen: boolean;
  setApps: (apps: AppDefinition[]) => void;
  selectDesktopApp: (appId: string | null) => void;
  openAppMenu: () => void;
  closeAppMenu: () => void;
  toggleAppMenu: () => void;
}

export const useDesktopStore = create<DesktopState>((set) => ({
  apps: {},
  wallpaper: DEFAULT_WALLPAPER,
  selectedDesktopAppId: null,
  appMenuOpen: false,
  setApps: (apps) =>
    set({
      apps: Object.fromEntries(apps.map((app) => [app.id, app])),
    }),
  selectDesktopApp: (appId) => set({ selectedDesktopAppId: appId }),
  openAppMenu: () => set({ appMenuOpen: true }),
  closeAppMenu: () => set({ appMenuOpen: false }),
  toggleAppMenu: () => set((state) => ({ appMenuOpen: !state.appMenuOpen })),
}));
