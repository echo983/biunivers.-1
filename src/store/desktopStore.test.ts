import { beforeEach, describe, expect, it } from "vitest";
import { useDesktopStore } from "./desktopStore";

describe("desktop store taskbar preferences", () => {
  beforeEach(() => {
    useDesktopStore.setState({
      pinnedAppIds: [],
      pinnedInitialized: false,
    });
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
