// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { InstalledAppRecord } from "./appStore.js";
import { projectInstalledApp } from "./projection.js";

const installed: InstalledAppRecord = {
  appId: "io.github.example.hello",
  repository: "https://github.com/example/hello",
  requestedRef: "v1.0.0",
  commitSha: "0123456789abcdef",
  version: "1.0.0",
  protocol: "biunivers.static-app/1",
  manifest: {
    formatVersion: 1,
    protocol: "biunivers.static-app/1",
    appId: "io.github.example.hello",
    version: "1.0.0",
    name: "Hello",
    description: "Example",
    license: "MIT",
    icon: "assets/icon.svg",
    window: {
      defaultWidth: 640,
      defaultHeight: 480,
      minWidth: 320,
      minHeight: 240,
    },
    configuration: [],
  },
  configuration: {},
  status: "active",
  installedAt: "2026-07-28T00:00:00.000Z",
  updatedAt: "2026-07-28T00:00:00.000Z",
};

describe("projectInstalledApp", () => {
  it("projects a managed record to a fixed iframe definition", () => {
    expect(projectInstalledApp(installed, "http://localhost:8081")).toEqual({
      id: installed.appId,
      name: "Hello",
      kind: "iframe",
      icon:
        "http://app-cd3ab3859ceac28abdef8189c8db9692c9566cd7.localhost:8081/apps/0123456789abcdef/assets/icon.svg",
      description: "Example",
      url:
        "http://app-cd3ab3859ceac28abdef8189c8db9692c9566cd7.localhost:8081/apps/0123456789abcdef/index.html",
      defaultWidth: 640,
      defaultHeight: 480,
      minWidth: 320,
      minHeight: 240,
      desktop: true,
      pinned: false,
      trusted: true,
    });
  });
});
