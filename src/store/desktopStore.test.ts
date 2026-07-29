import { beforeEach, describe, expect, it } from "vitest";
import { useDesktopStore } from "./desktopStore";

describe("desktop store taskbar preferences", () => {
  beforeEach(() => {
    useDesktopStore.setState({
      pinnedAppIds: [],
      pinnedInitialized: false,
      defaultResourceHandlers: {},
    });
  });

  it("sets and clears a default resource handler", () => {
    const key = "extension:.txt:edit";
    useDesktopStore.getState().setDefaultResourceHandler(key, {
      appId: "io.github.example.notes",
      handlerId: "text",
    });
    expect(useDesktopStore.getState().defaultResourceHandlers[key]).toEqual({
      appId: "io.github.example.notes",
      handlerId: "text",
    });

    useDesktopStore.getState().clearDefaultResourceHandler(key);
    expect(useDesktopStore.getState().defaultResourceHandlers).toEqual({});
  });

  it("uses configured pins once and respects a later empty user list", () => {
    useDesktopStore.getState().initializePinnedApps(["files"]);
    expect(useDesktopStore.getState().pinnedAppIds).toEqual(["files"]);

    useDesktopStore.getState().unpinApp("files");
    useDesktopStore.getState().initializePinnedApps(["files"]);
    expect(useDesktopStore.getState().pinnedAppIds).toEqual([]);
  });

  it("pins without duplicates and unpins an app", () => {
    useDesktopStore.getState().pinApp("files");
    useDesktopStore.getState().pinApp("files");
    expect(useDesktopStore.getState().pinnedAppIds).toEqual(["files"]);

    useDesktopStore.getState().unpinApp("files");
    expect(useDesktopStore.getState().pinnedAppIds).toEqual([]);
  });
});
