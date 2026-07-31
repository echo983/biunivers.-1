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
import type { WindowState } from "../types/desktop";
import {
  clearResourceLaunch,
  queueResourceLaunch,
} from "../openResource/launchBroker";

interface OpenAppOptions {
  restoreState?: boolean;
  focus?: boolean;
  launchId?: string;
}

function getWindowLayer() {
  const layer = document.getElementById("desktop-window-layer");
  if (!layer) {
    throw new Error("Desktop window layer is not available");
  }
  return layer;
}

function setWindowControlLabels(winbox: WinBox) {
  const minimizeControl = winbox.window.querySelector<HTMLElement>(".wb-min");
  const maximizeControl = winbox.window.querySelector<HTMLElement>(".wb-max");
  const closeControl = winbox.window.querySelector<HTMLElement>(".wb-close");

  if (minimizeControl) {
    minimizeControl.title = "最小化";
    minimizeControl.setAttribute("role", "button");
    minimizeControl.setAttribute("aria-label", "最小化");
    minimizeControl.tabIndex = 0;
  }
  if (maximizeControl) {
    const label = winbox.max ? "还原" : "最大化";
    maximizeControl.title = label;
    maximizeControl.setAttribute("role", "button");
    maximizeControl.setAttribute("aria-label", label);
    maximizeControl.tabIndex = 0;
  }
  if (closeControl) {
    closeControl.title = "关闭";
    closeControl.setAttribute("role", "button");
    closeControl.setAttribute("aria-label", "关闭");
    closeControl.tabIndex = 0;
  }
}

function hideWindow(appId: string) {
  const runtime = windowRuntimeMap.get(appId);
  if (!runtime) {
    return;
  }
  runtime.winbox.hide();
  runtime.winbox.blur();
  useDesktopStore.getState().updateWindow(appId, {
    hidden: true,
    active: false,
  });
  if (useDesktopStore.getState().activeAppId === appId) {
    useDesktopStore.getState().setActiveApp(null);
  }
}

function wireWindowControls(appId: string, winbox: WinBox) {
  const minimizeControl = winbox.window.querySelector<HTMLElement>(".wb-min");
  const maximizeControl = winbox.window.querySelector<HTMLElement>(".wb-max");
  const closeControl = winbox.window.querySelector<HTMLElement>(".wb-close");

  const minimize = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    hideWindow(appId);
  };
  const activateOnKeyboard = (
    event: KeyboardEvent,
    action: () => void,
  ) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      action();
    }
  };
  const activateWindow = () => {
    if (!winbox.hidden && !winbox.focused) {
      winbox.focus();
    }
  };

  winbox.window.addEventListener("pointerdown", activateWindow, true);
  minimizeControl?.addEventListener("click", minimize, true);
  minimizeControl?.addEventListener("keydown", (event) =>
    activateOnKeyboard(event, () => hideWindow(appId)),
  );
  maximizeControl?.addEventListener("keydown", (event) =>
    activateOnKeyboard(event, () => {
      if (winbox.max) {
        winbox.restore().focus();
      } else {
        winbox.maximize().focus();
      }
    }),
  );
  closeControl?.addEventListener("keydown", (event) =>
    activateOnKeyboard(event, () => {
      winbox.close();
    }),
  );
  setWindowControlLabels(winbox);
}

function finalizeClose(appId: string) {
  const runtime = windowRuntimeMap.get(appId);
  if (!runtime || runtime.closing) {
    return;
  }

  runtime.closing = true;
  useDesktopStore.getState().updateWindow(appId, {
    x: runtime.winbox.x,
    y: runtime.winbox.y,
    width: runtime.winbox.width,
    height: runtime.winbox.height,
  });
  windowRuntimeMap.delete(appId);
  clearResourceLaunch(appId);
  runtime.reactRoot.unmount();
  useDesktopStore.getState().removeWindow(appId);
}

export function openApp(appId: string, options: OpenAppOptions = {}) {
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
  if (options.launchId) {
    if (app.kind !== "iframe") {
      throw new Error("Only managed iframe apps can receive resources.");
    }
    queueResourceLaunch(appId, options.launchId);
  }

  const existing = windowRuntimeMap.get(appId);
  if (existing) {
    // A BWA open URL carries a fresh, one-time browser bootstrap ticket.
    // Reusing the WinBox must therefore also replace its rendered iframe;
    // merely focusing it would keep a ticket/session from before a Host restart.
    if (app.kind === "bwa") {
      existing.reactRoot.render(<WindowContent app={app} />);
    }
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
  const savedWindow = state.windows[appId];
  const bounds = savedWindow
    ? clampWindowBounds({
        x: savedWindow.x,
        y: savedWindow.y,
        width: savedWindow.width,
        height: savedWindow.height,
      })
    : getInitialWindowBounds(app);
  const restoredState: Pick<WindowState, "hidden" | "maximized"> =
    options.restoreState && savedWindow
      ? {
          hidden: savedWindow.hidden,
          maximized: savedWindow.maximized,
        }
      : { hidden: false, maximized: false };

  state.addWindow({
    appId,
    ...restoredState,
    active: false,
    ...bounds,
    openedAt: Date.now(),
  });

  try {
    const winboxRef: { current?: WinBox } = {};
    const winbox = new WinBox({
      id: `app-${app.id}`,
      title: app.name,
      icon: app.icon,
      root: getWindowLayer(),
      mount: container,
      class: ["no-full"],
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
      onmaximize: () => {
        useDesktopStore.getState().updateWindow(appId, {
          maximized: true,
          x: winboxRef.current?.x ?? bounds.x,
          y: winboxRef.current?.y ?? bounds.y,
          width: winboxRef.current?.width ?? bounds.width,
          height: winboxRef.current?.height ?? bounds.height,
        });
        if (winboxRef.current) {
          setWindowControlLabels(winboxRef.current);
        }
      },
      onrestore: () => {
        useDesktopStore
          .getState()
          .updateWindow(appId, { maximized: false });
        if (winboxRef.current) {
          setWindowControlLabels(winboxRef.current);
        }
      },
      onhide: () =>
        useDesktopStore.getState().updateWindow(appId, { hidden: true }),
      onshow: () =>
        useDesktopStore.getState().updateWindow(appId, { hidden: false }),
      onclose: () => {
        finalizeClose(appId);
        return false;
      },
    });
    winboxRef.current = winbox;

    windowRuntimeMap.set(appId, {
      winbox,
      reactRoot,
      container,
      closing: false,
    });
    wireWindowControls(appId, winbox);
    reactRoot.render(<WindowContent app={app} />);
    if (restoredState.maximized) {
      winbox.maximize(true);
    }
    if (restoredState.hidden) {
      winbox.hide(true);
      winbox.blur();
    } else if (options.focus !== false) {
      winbox.focus();
      useDesktopStore.getState().setActiveApp(appId);
    }
  } catch (error) {
    if (options.launchId) {
      clearResourceLaunch(appId);
    }
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

export function resetDesktopWindows() {
  for (const appId of [...windowRuntimeMap.keys()]) {
    closeApp(appId);
  }
  useDesktopStore.getState().clearWindowState();
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
    hideWindow(appId);
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
