import { describe, expect, it } from "vitest";
import { loadComputeRuntimeConfig } from "./computeRuntimeConfig.js";

const TOKEN = "11".repeat(32);
const IMAGE = `registry.example/biunivers/diagnostic@sha256:${"22".repeat(32)}`;

describe("loadComputeRuntimeConfig", () => {
  it("builds a fixed minimal diagnostic executor and private paths", () => {
    const config = loadComputeRuntimeConfig({
      BIUNIVERS_DATA_DIR: "/srv/biunivers",
      BIUNIVERS_RUNTIME_AUTH_TOKEN: TOKEN,
      BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE: IMAGE,
    });
    expect(config).toMatchObject({
      runRoot: "/srv/biunivers/compute-runtime/runs",
      cachePath: "/srv/biunivers/compute-runtime/chunk-cache",
      socketPath: "/srv/biunivers/compute-runtime/runtime.sock",
      pvlogfsBinary: "/opt/biunivers/bin/biunivers-pvlogfs",
      workspaceCowScannerBinary:
        "/opt/biunivers/bin/biunivers-workspace-cow-scan",
      authenticationTokenHex: TOKEN,
    });
    expect(config.executors).toEqual([
      expect.objectContaining({
        executorId: "system.diagnostic",
        image: IMAGE,
        uid: 65532,
        gid: 65532,
        pidsLimit: 64,
      }),
    ]);
  });

  it("accepts a local content-addressed image identity", () => {
    const config = loadComputeRuntimeConfig({
      BIUNIVERS_RUNTIME_AUTH_TOKEN: TOKEN,
      BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE: `sha256:${"33".repeat(32)}`,
    });
    expect(config.executors[0]?.image).toBe(`sha256:${"33".repeat(32)}`);
  });

  it.each([
    [{ BIUNIVERS_RUNTIME_AUTH_TOKEN: "short" }, "AUTH_TOKEN"],
    [
      { BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE: "diagnostic:latest" },
      "digest-pinned",
    ],
    [{ BIUNIVERS_RUNTIME_ROOT: "../runs" }, "RUNTIME_ROOT"],
    [{ BIUNIVERS_RUNTIME_SOCKET: "/" }, "RUNTIME_SOCKET"],
  ])("rejects unsafe operator configuration", (override, message) => {
    expect(() =>
      loadComputeRuntimeConfig({
        BIUNIVERS_RUNTIME_AUTH_TOKEN: TOKEN,
        BIUNIVERS_DIAGNOSTIC_EXECUTOR_IMAGE: IMAGE,
        ...override,
      }),
    ).toThrow(message);
  });
});
