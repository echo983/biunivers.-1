import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApps } from "../store/defaults";
import { useDesktopStore } from "../store/desktopStore";

const winboxMock = vi.hoisted(() => ({
  instances: [] as Array<{
    options: Record<string, unknown>;
    close: () => void;
    focus: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    focused: boolean;
    window: HTMLElement;
  }>,
}));

vi.mock("winbox/src/js/winbox.js", () => ({
  default: class MockWinBox {
    x = 0;
    y = 0;
    width = 560;
    height = 420;
    window = document.createElement("div");
    max = false;
    hidden = false;
    focused = true;
    options: Record<string, unknown>;
    show = vi.fn(() => {
      this.hidden = false;
      const onshow = this.options.onshow as (() => void) | undefined;
      onshow?.();
      return this;
    });
    focus = vi.fn(() => {
      this.focused = true;
      const onfocus = this.options.onfocus as (() => void) | undefined;
      onfocus?.();
      return this;
    });
    blur = vi.fn(() => {
      this.focused = false;
      const onblur = this.options.onblur as (() => void) | undefined;
      onblur?.();
      return this;
    });
    hide = vi.fn(() => {
      this.hidden = true;
      const onhide = this.options.onhide as (() => void) | undefined;
      onhide?.();
      return this;
    });
    maximize = vi.fn(() => this);
    restore = vi.fn(() => this);
    resize = vi.fn(() => this);
    move = vi.fn(() => this);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.window.innerHTML =
        '<span class="wb-min"></span><span class="wb-max"></span><span class="wb-close"></span>';
      winboxMock.instances.push(this);
    }

    close = () => {
      const onclose = this.options.onclose as (() => boolean | void) | undefined;
      onclose?.();
    };
  },
}));

import {
  activateTaskbarApp,
  closeApp,
  openApp,
} from "./windowController";
import { creatingAppIds, windowRuntimeMap } from "./windowRuntimeMap";
import {
  pendingResourceLaunch,
  resetResourceLaunchBrokerForTests,
} from "../openResource/launchBroker";

describe("window controller", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="desktop-window-layer"></div>';
    winboxMock.instances.length = 0;
    windowRuntimeMap.clear();
    creatingAppIds.clear();
    resetResourceLaunchBrokerForTests();
    useDesktopStore.setState({
      apps: Object.fromEntries(defaultApps.map((app) => [app.id, app])),
      windows: {},
      runningAppIds: [],
      activeAppId: null,
    });
  });

  it("queues a resource launch while opening or focusing an iframe app", () => {
    const iframeApp = {
      ...defaultApps[0],
      id: "io.github.example.notes",
      kind: "iframe" as const,
      url: "http://notes.localhost:8081/index.html",
    };
    useDesktopStore.setState({
      apps: {
        ...useDesktopStore.getState().apps,
        [iframeApp.id]: iframeApp,
      },
    });
    act(() => openApp(iframeApp.id, { launchId: "a".repeat(43) }));
    expect(pendingResourceLaunch(iframeApp.id)).toBe("a".repeat(43));

    const instance = winboxMock.instances[0];
    instance.show.mockClear();
    act(() => openApp(iframeApp.id, { launchId: "a".repeat(43) }));
    expect(instance.show).toHaveBeenCalledOnce();
    act(() => closeApp(iframeApp.id));
    expect(pendingResourceLaunch(iframeApp.id)).toBeUndefined();
  });

  afterEach(() => {
    for (const appId of [...windowRuntimeMap.keys()]) {
      act(() => closeApp(appId));
    }
  });

  it("reuses the existing window for a single-instance app", () => {
    act(() => openApp("system.about"));
    const instance = winboxMock.instances[0];
    instance.show.mockClear();
    instance.focus.mockClear();
    act(() => openApp("system.about"));

    expect(winboxMock.instances).toHaveLength(1);
    expect(instance.show).toHaveBeenCalledOnce();
    expect(instance.focus).toHaveBeenCalledOnce();
    expect(windowRuntimeMap.has("system.about")).toBe(true);
  });

  it("focuses a covered window when its visible area is pressed", () => {
    act(() => {
      openApp("system.about");
      openApp("system.settings");
    });
    const covered = winboxMock.instances[0];
    covered.focused = false;
    covered.focus.mockClear();

    act(() => {
      covered.window.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true }),
      );
    });

    expect(covered.focus).toHaveBeenCalledOnce();
    expect(useDesktopStore.getState().activeAppId).toBe("system.about");
  });

  it("cleans runtime and product state even if close is requested twice", () => {
    act(() => openApp("system.about"));
    const instance = winboxMock.instances[0];

    act(() => {
      instance.close();
      instance.close();
    });

    expect(windowRuntimeMap.has("system.about")).toBe(false);
    expect(
      useDesktopStore.getState().runningAppIds.includes("system.about"),
    ).toBe(false);
    expect(useDesktopStore.getState().windows["system.about"]).toBeDefined();
    expect(useDesktopStore.getState().activeAppId).toBeNull();
  });

  it("hides the active window and restores it from the taskbar", () => {
    act(() => openApp("system.about"));

    act(() => activateTaskbarApp("system.about"));
    expect(useDesktopStore.getState().windows["system.about"].hidden).toBe(true);
    expect(useDesktopStore.getState().activeAppId).toBeNull();

    act(() => activateTaskbarApp("system.about"));
    expect(useDesktopStore.getState().windows["system.about"].hidden).toBe(false);
    expect(useDesktopStore.getState().activeAppId).toBe("system.about");
  });
});
