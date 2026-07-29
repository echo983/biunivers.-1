export type AppKind = "internal" | "iframe" | "external";
export type ConfigStatus = "loading" | "ready" | "error";

export interface AppDefinition {
  id: string;
  name: string;
  kind: AppKind;
  icon: string;
  description?: string;
  url?: string;
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  desktop: boolean;
  pinned: boolean;
  trusted?: boolean;
  resourceHandlers?: Array<{
    id: string;
    actions: Array<"open" | "edit">;
    extensions: string[];
    mediaTypes?: string[];
    access: "read" | "read-write";
  }>;
}

export interface WindowState {
  appId: string;
  hidden: boolean;
  maximized: boolean;
  active: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  openedAt: number;
}

export interface DefaultResourceHandler {
  appId: string;
  handlerId: string;
}

export interface PersistedDesktopState {
  schemaVersion: 2;
  preferencesInitialized: true;
  wallpaper: string;
  pinnedAppIds: string[];
  runningAppIds: string[];
  activeAppId: string | null;
  defaultResourceHandlers: Record<string, DefaultResourceHandler>;
  windows: Record<
    string,
    {
      hidden: boolean;
      maximized: boolean;
      x: number;
      y: number;
      width: number;
      height: number;
    }
  >;
}
