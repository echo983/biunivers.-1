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
  }>,
}));

vi.mock("winbox/src/js/winbox.js", () => ({
  default: class MockWinBox {
    x = 0;
    y = 0;
    width = 560;
    height = 420;
    max = false;
    hidden = false;
    focused = true;
    options: Record<string, unknown>;
    show = vi.fn();
    focus = vi.fn(() => {
      const onfocus = this.options.onfocus as (() => void) | undefined;
      onfocus?.();
      return this;
    });
    blur = vi.fn(() => this);
    maximize = vi.fn(() => this);
    restore = vi.fn(() => this);
    resize = vi.fn(() => this);
    move = vi.fn(() => this);

    constructor(options: Record<string, unknown>) {
      this.options = options;
      winboxMock.instances.push(this);
    }

    close = () => {
      const onclose = this.options.onclose as (() => boolean | void) | undefined;
      onclose?.();
    };
  },
}));

import { closeApp, openApp } from "./windowController";
import { creatingAppIds, windowRuntimeMap } from "./windowRuntimeMap";

describe("window controller", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="desktop-window-layer"></div>';
    winboxMock.instances.length = 0;
    windowRuntimeMap.clear();
    creatingAppIds.clear();
    useDesktopStore.setState({
      apps: Object.fromEntries(defaultApps.map((app) => [app.id, app])),
      windows: {},
      activeAppId: null,
    });
  });

  afterEach(() => {
    for (const appId of [...windowRuntimeMap.keys()]) {
      act(() => closeApp(appId));
    }
  });

  it("reuses the existing window for a single-instance app", () => {
    act(() => openApp("system.about"));
    act(() => openApp("system.about"));

    expect(winboxMock.instances).toHaveLength(1);
    expect(winboxMock.instances[0].show).toHaveBeenCalledOnce();
    expect(winboxMock.instances[0].focus).toHaveBeenCalledOnce();
    expect(windowRuntimeMap.has("system.about")).toBe(true);
  });

  it("cleans runtime and product state even if close is requested twice", () => {
    act(() => openApp("system.about"));
    const instance = winboxMock.instances[0];

    act(() => {
      instance.close();
      instance.close();
    });

    expect(windowRuntimeMap.has("system.about")).toBe(false);
    expect(useDesktopStore.getState().windows["system.about"]).toBeUndefined();
    expect(useDesktopStore.getState().activeAppId).toBeNull();
  });
});
