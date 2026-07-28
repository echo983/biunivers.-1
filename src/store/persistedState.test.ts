import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultApps } from "./defaults";
import {
  DESKTOP_STORAGE_KEY,
  parsePersistedDesktopState,
  readPersistedDesktopState,
  restoreDesktopSession,
  stopDesktopPersistence,
} from "./persistedState";
import { useDesktopStore } from "./desktopStore";

vi.mock("../windows/windowController", () => ({
  openApp: vi.fn(),
}));

describe("persisted desktop state", () => {
  beforeEach(() => {
    stopDesktopPersistence();
    localStorage.clear();
    useDesktopStore.setState({
      apps: Object.fromEntries(defaultApps.map((app) => [app.id, app])),
      windows: {},
      runningAppIds: [],
      activeAppId: null,
      pinnedAppIds: [],
      pinnedInitialized: false,
    });
  });

  it("rejects corrupted and unknown-version data", () => {
    expect(parsePersistedDesktopState("{broken")).toBeNull();
    expect(
      parsePersistedDesktopState(
        JSON.stringify({
          schemaVersion: 2,
          preferencesInitialized: true,
        }),
      ),
    ).toBeNull();
  });

  it("removes damaged local storage data", () => {
    localStorage.setItem(DESKTOP_STORAGE_KEY, "not json");
    expect(readPersistedDesktopState()).toBeNull();
    expect(localStorage.getItem(DESKTOP_STORAGE_KEY)).toBeNull();
  });

  it("cleans deleted and external apps while preserving an empty pin list", async () => {
    const persisted = parsePersistedDesktopState(
      JSON.stringify({
        schemaVersion: 1,
        preferencesInitialized: true,
        wallpaper: "/custom.jpg",
        pinnedAppIds: [],
        runningAppIds: ["system.about", "deleted", "website"],
        activeAppId: "deleted",
        windows: {
          "system.about": {
            hidden: false,
            maximized: false,
            x: 10,
            y: 10,
            width: 500,
            height: 400,
          },
          deleted: {
            hidden: false,
            maximized: false,
            x: 0,
            y: 0,
            width: 500,
            height: 400,
          },
          website: {
            hidden: false,
            maximized: false,
            x: 0,
            y: 0,
            width: 500,
            height: 400,
          },
        },
      }),
    );
    const apps = [
      ...defaultApps,
      {
        ...defaultApps[0],
        id: "website",
        kind: "external" as const,
        url: "https://example.com",
      },
    ];

    await restoreDesktopSession(persisted, apps);

    const state = useDesktopStore.getState();
    expect(state.pinnedAppIds).toEqual([]);
    expect(state.runningAppIds).toEqual(["system.about"]);
    expect(Object.keys(state.windows)).toEqual(["system.about"]);
    expect(state.activeAppId).toBeNull();
    expect(state.wallpaper).toBe("/custom.jpg");
  });
});
