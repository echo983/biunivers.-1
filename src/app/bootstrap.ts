import { defaultApps } from "../store/defaults";
import { useDesktopStore } from "../store/desktopStore";

let bootstrapped = false;

export function bootstrapDesktop() {
  if (bootstrapped) {
    return;
  }

  bootstrapped = true;
  useDesktopStore.getState().setApps(defaultApps);
}
