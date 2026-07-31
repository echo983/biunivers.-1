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

  it("rejects an IP App Origin because it cannot isolate app subdomains", () => {
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_APP_ORIGIN: "http://127.0.0.1:8081",
      }),
    ).toThrow("不能使用 IP");
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

  it("keeps File Service disabled unless explicitly enabled", () => {
    expect(loadServerConfig(validEnvironment).fileService).toBeUndefined();
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_FILE_ENABLED: "true",
      }),
    ).toThrow("BIUNIVERS_FILE_S3_ENDPOINT");
  });

  it("loads enabled File Service configuration without exposing defaults as secrets", () => {
    const config = loadServerConfig({
      ...validEnvironment,
      BIUNIVERS_FILE_ENABLED: "true",
      BIUNIVERS_FILE_INITIALIZE: "true",
      BIUNIVERS_FILE_S3_ENDPOINT: "https://account.r2.example.com",
      BIUNIVERS_FILE_S3_BUCKET: "files",
      BIUNIVERS_FILE_NAMESPACE: "users/alice",
      BIUNIVERS_FILE_S3_ACCESS_KEY_ID: "access-key",
      BIUNIVERS_FILE_S3_SECRET_ACCESS_KEY: "secret-key",
    });

    expect(config.fileService).toMatchObject({
      initialize: true,
      endpoint: "https://account.r2.example.com",
      region: "auto",
      bucket: "files",
      namespace: "users/alice",
      forcePathStyle: true,
      writerId: "biunivers-host",
    });
    expect(config.fileService?.databasePath).toMatch(
      /file-service\/file-service\.sqlite$/,
    );
  });

  it("keeps BWA disabled by default and validates its Runtime control channel", () => {
    expect(loadServerConfig(validEnvironment).bwaManager).toBeUndefined();
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_BWA_ENABLED: "true",
      }),
    ).toThrow("需要启用 File Service");
    expect(() =>
      loadServerConfig({
        ...validEnvironment,
        BIUNIVERS_BWA_ENABLED: "true",
        BIUNIVERS_FILE_ENABLED: "true",
        BIUNIVERS_FILE_S3_ENDPOINT: "https://account.r2.example.com",
        BIUNIVERS_FILE_S3_BUCKET: "files",
        BIUNIVERS_FILE_NAMESPACE: "users/alice",
        BIUNIVERS_FILE_S3_ACCESS_KEY_ID: "access-key",
        BIUNIVERS_FILE_S3_SECRET_ACCESS_KEY: "secret-key",
        BIUNIVERS_RUNTIME_AUTH_TOKEN: "short",
      }),
    ).toThrow("64 位");
  });

  it("loads the optional BWA Manager configuration", () => {
    const config = loadServerConfig({
      ...validEnvironment,
      BIUNIVERS_FILE_ENABLED: "true",
      BIUNIVERS_FILE_S3_ENDPOINT: "https://account.r2.example.com",
      BIUNIVERS_FILE_S3_BUCKET: "files",
      BIUNIVERS_FILE_NAMESPACE: "users/alice",
      BIUNIVERS_FILE_S3_ACCESS_KEY_ID: "access-key",
      BIUNIVERS_FILE_S3_SECRET_ACCESS_KEY: "secret-key",
      BIUNIVERS_BWA_ENABLED: "true",
      BIUNIVERS_RUNTIME_AUTH_TOKEN: "11".repeat(32),
    });
    expect(config.bwaManager).toMatchObject({
      runtimeAuthenticationTokenHex: "11".repeat(32),
    });
    expect(config.bwaManager?.runtimeSocketPath).toMatch(
      /compute-runtime\/runtime\.sock$/,
    );
    expect(config.bwaManager?.secretStorePath).toMatch(
      /private\/bwa-secrets\.json$/,
    );
  });
});
