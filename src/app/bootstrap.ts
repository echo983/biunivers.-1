import { defaultApps } from "../store/defaults";
import { useDesktopStore } from "../store/desktopStore";
import {
  loadLegacyAppConfig,
  loadManagedAppConfig,
} from "../config/loadAppConfig";
import { mergeAppSources } from "../apps/registry";
import {
  readPersistedDesktopState,
  restoreDesktopSession,
} from "../store/persistedState";

let bootstrapped = false;

export async function refreshApplicationRegistry() {
  const [legacy, managed] = await Promise.all([
    loadLegacyAppConfig(),
    loadManagedAppConfig(),
  ]);
  const warnings = [...legacy.warnings, ...managed.warnings];
  const apps = mergeAppSources(legacy.apps, managed.apps, warnings);
  const errors = [legacy.error, managed.error].filter(Boolean);
  const status =
    legacy.status === "ready" && managed.status === "ready"
      ? "ready"
      : "error";

  useDesktopStore.getState().setApps(apps);
  useDesktopStore
    .getState()
    .setConfigState(status, warnings, errors.join("；") || undefined);
  return apps;
}

export async function bootstrapDesktop() {
  if (bootstrapped) {
    return;
  }

  bootstrapped = true;
  const persisted = readPersistedDesktopState();
  const store = useDesktopStore.getState();
  store.setApps(defaultApps);
  store.setConfigState("loading");

  const apps = await refreshApplicationRegistry();
  useDesktopStore
    .getState()
    .initializePinnedApps(
      apps.filter((app) => app.pinned).map((app) => app.id),
    );
  await restoreDesktopSession(persisted, apps);
}
