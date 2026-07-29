import type {
  AppDefinition,
  PersistedDesktopState,
  WindowState,
} from "../types/desktop";
import { DEFAULT_WALLPAPER } from "./defaults";
import { useDesktopStore } from "./desktopStore";
import { openApp } from "../windows/windowController";

export const DESKTOP_STORAGE_KEY = "biunivers.desktop.v1";
const WRITE_DELAY = 300;

let persistenceSuspended = true;
let writeTimer: number | undefined;
let stopSubscription: (() => void) | undefined;
let removePagehideListener: (() => void) | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseDefaultResourceHandlers(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const result: PersistedDesktopState["defaultResourceHandlers"] = {};
  for (const [key, handler] of Object.entries(value)) {
    if (
      !/^extension:\.[a-z0-9]+:(?:open|edit)$/.test(key) ||
      !isRecord(handler) ||
      typeof handler.appId !== "string" ||
      !/^[a-z0-9.-]+$/.test(handler.appId) ||
      typeof handler.handlerId !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(handler.handlerId)
    ) {
      return null;
    }
    result[key] = {
      appId: handler.appId,
      handlerId: handler.handlerId,
    };
  }
  return result;
}

export function parsePersistedDesktopState(
  value: string | null,
): PersistedDesktopState | null {
  if (value === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !isRecord(parsed) ||
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) ||
      parsed.preferencesInitialized !== true ||
      typeof parsed.wallpaper !== "string" ||
      !isStringArray(parsed.pinnedAppIds) ||
      !isStringArray(parsed.runningAppIds) ||
      (parsed.activeAppId !== null &&
        typeof parsed.activeAppId !== "string") ||
      !isRecord(parsed.windows)
    ) {
      return null;
    }

    const windows: PersistedDesktopState["windows"] = {};
    for (const [appId, window] of Object.entries(parsed.windows)) {
      if (
        !isRecord(window) ||
        typeof window.hidden !== "boolean" ||
        typeof window.maximized !== "boolean" ||
        !isFiniteNumber(window.x) ||
        !isFiniteNumber(window.y) ||
        !isFiniteNumber(window.width) ||
        !isFiniteNumber(window.height) ||
        window.width <= 0 ||
        window.height <= 0
      ) {
        return null;
      }
      windows[appId] = {
        hidden: window.hidden,
        maximized: window.maximized,
        x: window.x,
        y: window.y,
        width: window.width,
        height: window.height,
      };
    }

    const defaultResourceHandlers =
      parsed.schemaVersion === 1
        ? {}
        : parseDefaultResourceHandlers(parsed.defaultResourceHandlers);
    if (defaultResourceHandlers === null) {
      return null;
    }

    return {
      schemaVersion: 2,
      preferencesInitialized: true,
      wallpaper: parsed.wallpaper,
      pinnedAppIds: [...new Set(parsed.pinnedAppIds)],
      runningAppIds: [...new Set(parsed.runningAppIds)],
      activeAppId: parsed.activeAppId,
      defaultResourceHandlers,
      windows,
    };
  } catch {
    return null;
  }
}

export function readPersistedDesktopState() {
  const raw = localStorage.getItem(DESKTOP_STORAGE_KEY);
  const state = parsePersistedDesktopState(raw);
  if (raw !== null && state === null) {
    localStorage.removeItem(DESKTOP_STORAGE_KEY);
  }
  return state;
}

function serializeCurrentDesktop(): PersistedDesktopState {
  const state = useDesktopStore.getState();
  return {
    schemaVersion: 2,
    preferencesInitialized: true,
    wallpaper: state.wallpaper,
    pinnedAppIds: state.pinnedAppIds,
    runningAppIds: state.runningAppIds,
    activeAppId: state.activeAppId,
    defaultResourceHandlers: state.defaultResourceHandlers,
    windows: Object.fromEntries(
      Object.entries(state.windows).map(([appId, window]) => [
        appId,
        {
          hidden: window.hidden,
          maximized: window.maximized,
          x: window.x,
          y: window.y,
          width: window.width,
          height: window.height,
        },
      ]),
    ),
  };
}

export function flushDesktopPersistence() {
  if (persistenceSuspended) {
    return;
  }
  window.clearTimeout(writeTimer);
  writeTimer = undefined;
  localStorage.setItem(
    DESKTOP_STORAGE_KEY,
    JSON.stringify(serializeCurrentDesktop()),
  );
}

function schedulePersistence() {
  if (persistenceSuspended) {
    return;
  }
  window.clearTimeout(writeTimer);
  writeTimer = window.setTimeout(flushDesktopPersistence, WRITE_DELAY);
}

export function startDesktopPersistence() {
  stopDesktopPersistence();
  persistenceSuspended = false;
  stopSubscription = useDesktopStore.subscribe(schedulePersistence);
  const handlePagehide = () => flushDesktopPersistence();
  window.addEventListener("pagehide", handlePagehide);
  removePagehideListener = () =>
    window.removeEventListener("pagehide", handlePagehide);
}

export function stopDesktopPersistence() {
  persistenceSuspended = true;
  window.clearTimeout(writeTimer);
  writeTimer = undefined;
  stopSubscription?.();
  stopSubscription = undefined;
  removePagehideListener?.();
  removePagehideListener = undefined;
}

export function clearLocalDesktopData() {
  stopDesktopPersistence();
  localStorage.removeItem(DESKTOP_STORAGE_KEY);
  window.location.reload();
}

function reconcilePersistedState(
  persisted: PersistedDesktopState,
  apps: AppDefinition[],
) {
  const appMap = new Map(apps.map((app) => [app.id, app]));
  const validWindowId = (id: string) => {
    const app = appMap.get(id);
    return Boolean(app && app.kind !== "external");
  };
  const pinnedAppIds = persisted.pinnedAppIds.filter((id) => appMap.has(id));
  const runningAppIds = persisted.runningAppIds.filter(
    (id) => validWindowId(id) && persisted.windows[id],
  );
  const windows: Record<string, WindowState> = {};

  for (const [appId, window] of Object.entries(persisted.windows)) {
    if (!validWindowId(appId)) {
      continue;
    }
    windows[appId] = {
      appId,
      ...window,
      active: false,
      openedAt: Date.now(),
    };
  }

  const activeAppId =
    persisted.activeAppId &&
    runningAppIds.includes(persisted.activeAppId) &&
    !windows[persisted.activeAppId]?.hidden
      ? persisted.activeAppId
      : null;

  return {
    wallpaper: persisted.wallpaper || DEFAULT_WALLPAPER,
    pinnedAppIds,
    runningAppIds,
    windows,
    activeAppId,
    defaultResourceHandlers: persisted.defaultResourceHandlers,
  };
}

export async function restoreDesktopSession(
  persisted: PersistedDesktopState | null,
  apps: AppDefinition[],
) {
  if (!persisted) {
    startDesktopPersistence();
    return;
  }

  const reconciled = reconcilePersistedState(persisted, apps);
  useDesktopStore.getState().hydrateDesktop(reconciled);

  for (const appId of reconciled.runningAppIds) {
    openApp(appId, { restoreState: true, focus: false });
  }

  if (reconciled.activeAppId) {
    openApp(reconciled.activeAppId);
  } else {
    useDesktopStore.getState().setActiveApp(null);
  }

  startDesktopPersistence();
  flushDesktopPersistence();
}
