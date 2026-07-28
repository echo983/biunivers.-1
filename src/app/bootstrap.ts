import { defaultApps } from "../store/defaults";
import { useDesktopStore } from "../store/desktopStore";
import { loadAppConfig } from "../config/loadAppConfig";

let bootstrapped = false;

export async function bootstrapDesktop() {
  if (bootstrapped) {
    return;
  }

  bootstrapped = true;
  const store = useDesktopStore.getState();
  store.setApps(defaultApps);
  store.setConfigState("loading");

  const result = await loadAppConfig();
  useDesktopStore.getState().setApps(result.apps);
  useDesktopStore
    .getState()
    .initializePinnedApps(
      result.apps.filter((app) => app.pinned).map((app) => app.id),
    );
  useDesktopStore
    .getState()
    .setConfigState(result.status, result.warnings, result.error);
}
