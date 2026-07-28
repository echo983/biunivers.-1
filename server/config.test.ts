// @vitest-environment node

import { describe, expect, it } from "vitest";
import { loadServerConfig } from "./config.js";

const validEnvironment = {
  BIUNIVERS_ADMIN_TOKEN: "a-secure-token-value",
  BIUNIVERS_DESKTOP_ORIGIN: "http://localhost:8080",
  BIUNIVERS_APP_ORIGIN: "http://localhost:8081",
  BIUNIVERS_DATA_DIR: "./test-data",
};

describe("loadServerConfig", () => {
  it("loads defaults and resolves the data directory", () => {
    const config = loadServerConfig(validEnvironment);

    expect(config.desktopPort).toBe(8080);
    expect(config.appPort).toBe(8081);
    expect(config.dataDir).toMatch(/test-data$/);
  });

  it("rejects equal desktop and app origins", () => {
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_APP_ORIGIN: validEnvironment.BIUNIVERS_DESKTOP_ORIGIN,
      }),
    ).toThrow("必须不同");
  });

  it("rejects weak admin tokens and origins with paths", () => {
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_ADMIN_TOKEN: "replace-me",
      }),
    ).toThrow("长度至少为 16");

    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_APP_ORIGIN: "https://apps.example.com/path",
      }),
    ).toThrow("必须是无路径");
  });
});
