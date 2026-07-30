import { describe, expect, it } from "vitest";
import { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { WormholeControlService } from "./wormholeControlService.js";
import { WormholeRuntime } from "./wormholeRuntime.js";

describe("WormholeControlService", () => {
  it("allows only the system Wormhole instance", () => {
    const capabilities = new FileCapabilityRegistry();
    const runtime = new WormholeRuntime({
      randomBytes: (size) => new Uint8Array(size),
    });
    const service = new WormholeControlService(capabilities, runtime);
    const wormholeToken = capabilities.createInstance(
      "system.wormhole",
      "wormhole-window",
    ).instanceToken;
    const fileToken = capabilities.createInstance(
      "system.files",
      "files-window",
    ).instanceToken;

    expect(service.enable(wormholeToken)).toMatchObject({ enabled: true });
    expect(() => service.status(fileToken)).toThrowError(
      expect.objectContaining({ code: "PERMISSION_DENIED" }),
    );
    expect(service.disable(wormholeToken)).toEqual({ enabled: false });
  });
});
