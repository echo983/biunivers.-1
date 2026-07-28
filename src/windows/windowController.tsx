import { createRoot } from "react-dom/client";
import WinBox from "winbox/src/js/winbox.js";
import { useDesktopStore } from "../store/desktopStore";
import { WindowContent } from "./WindowContent";
import {
  clampWindowBounds,
  getAvailableViewport,
  getInitialWindowBounds,
  TASKBAR_HEIGHT,
} from "./windowBounds";
import { creatingAppIds, windowRuntimeMap } from "./windowRuntimeMap";
import { openExternalApp } from "../apps/openExternalApp";

function getWindowLayer() {
  const layer = document.getElementById("desktop-window-layer");
  if (!layer) {
    throw new Error("Desktop window layer is not available");
  }
  return layer;
}

function finalizeClose(appId: string) {
  const runtime = windowRuntimeMap.get(appId);
  if (!runtime || runtime.closing) {
    return;
  }

  runtime.closing = true;
  windowRuntimeMap.delete(appId);
  runtime.reactRoot.unmount();
  useDesktopStore.getState().removeWindow(appId);
}

export function openApp(appId: string) {
  const state = useDesktopStore.getState();
  const app = state.apps[appId];

  if (!app) {
    return;
  }

  if (app.kind === "external") {
    if (app.url) {
      openExternalApp(app.url);
    }
    return;
  }

  const existing = windowRuntimeMap.get(appId);
  if (existing) {
    existing.winbox.show();
    existing.winbox.focus();
    return;
  }

  if (creatingAppIds.has(appId)) {
    return;
  }

  creatingAppIds.add(appId);
  const container = document.createElement("div");
  container.className = "app-window-root";
  const reactRoot = createRoot(container);
  const bounds = getInitialWindowBounds(app);

  state.addWindow({
    appId,
    hidden: false,
    maximized: false,
    active: false,
    ...bounds,
    openedAt: Date.now(),
  });

  try {
    const winbox = new WinBox({
      id: `app-${app.id}`,
      title: app.name,
      icon: app.icon,
      root: getWindowLayer(),
      mount: container,
      class: ["no-min", "no-full"],
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      minwidth: app.minWidth,
      minheight: app.minHeight,
      bottom: TASKBAR_HEIGHT,
      onfocus: () => useDesktopStore.getState().setActiveApp(appId),
      onblur: () => {
        if (useDesktopStore.getState().activeAppId === appId) {
          useDesktopStore.getState().setActiveApp(null);
        }
      },
      onmove: (x, y) =>
        useDesktopStore.getState().updateWindow(appId, { x, y }),
      onresize: (width, height) =>
        useDesktopStore
          .getState()
          .updateWindow(appId, { width, height }),
      onmaximize: () =>
        useDesktopStore
          .getState()
          .updateWindow(appId, { maximized: true }),
      onrestore: () =>
        useDesktopStore
          .getState()
          .updateWindow(appId, { maximized: false }),
      onhide: () =>
        useDesktopStore.getState().updateWindow(appId, { hidden: true }),
      onshow: () =>
        useDesktopStore.getState().updateWindow(appId, { hidden: false }),
      onclose: () => {
        finalizeClose(appId);
        return false;
      },
    });

    windowRuntimeMap.set(appId, {
      winbox,
      reactRoot,
      container,
      closing: false,
    });
    reactRoot.render(<WindowContent app={app} />);
    useDesktopStore.getState().setActiveApp(appId);
  } catch (error) {
    reactRoot.unmount();
    useDesktopStore.getState().removeWindow(appId);
    console.error(`Failed to open application "${appId}"`, error);
  } finally {
    creatingAppIds.delete(appId);
  }
}

export function closeApp(appId: string) {
  windowRuntimeMap.get(appId)?.winbox.close();
}

export function activateTaskbarApp(appId: string) {
  const runtime = windowRuntimeMap.get(appId);
  if (!runtime) {
    openApp(appId);
    return;
  }

  if (runtime.winbox.hidden) {
    runtime.winbox.show();
    runtime.winbox.focus();
    useDesktopStore.getState().updateWindow(appId, { hidden: false });
    return;
  }

  if (runtime.winbox.focused) {
    runtime.winbox.hide();
    runtime.winbox.blur();
    useDesktopStore.getState().updateWindow(appId, {
      hidden: true,
      active: false,
    });
    useDesktopStore.getState().setActiveApp(null);
    return;
  }

  runtime.winbox.focus();
}

export function clampOpenWindows() {
  const viewport = getAvailableViewport();

  for (const [appId, runtime] of windowRuntimeMap) {
    if (runtime.winbox.max) {
      runtime.winbox.restore();
      runtime.winbox.maximize();
      continue;
    }

    const bounds = clampWindowBounds(
      {
        x: runtime.winbox.x,
        y: runtime.winbox.y,
        width: runtime.winbox.width,
        height: runtime.winbox.height,
      },
      viewport,
    );
    runtime.winbox.resize(bounds.width, bounds.height);
    runtime.winbox.move(bounds.x, bounds.y);
    useDesktopStore.getState().updateWindow(appId, bounds);
  }
}
