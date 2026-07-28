import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadLegacyAppConfig,
  loadManagedAppConfig,
} from "./loadAppConfig";

const iframeApp = {
  id: "io.github.example.hello",
  name: "Hello",
  kind: "iframe",
  icon: "http://localhost:8081/apps/hello/icon.svg",
  url: "http://localhost:8081/apps/hello/index.html",
  defaultWidth: 640,
  defaultHeight: 480,
  desktop: true,
  pinned: false,
  trusted: true,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("application source loaders", () => {
  it("loads legacy arrays and managed response objects", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url === "/api/v1/apps" ? { apps: [iframeApp] } : [iframeApp],
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadLegacyAppConfig()).resolves.toMatchObject({
      status: "ready",
      apps: [iframeApp],
    });
    await expect(loadManagedAppConfig()).resolves.toMatchObject({
      status: "ready",
      apps: [iframeApp],
    });
  });

  it("returns an empty source and a useful error when managed apps fail", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );

    await expect(loadManagedAppConfig()).resolves.toEqual({
      status: "error",
      apps: [],
      warnings: [],
      error: "无法加载已安装应用：请求失败：HTTP 503",
    });
  });
});
