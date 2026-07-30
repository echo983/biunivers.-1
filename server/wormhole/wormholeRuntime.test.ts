import { describe, expect, it } from "vitest";
import {
  WormholeRuntime,
  WormholeRuntimeError,
} from "./wormholeRuntime.js";

describe("WormholeRuntime", () => {
  it("starts disabled and creates one ten-character in-memory credential", () => {
    let now = 1000;
    const runtime = new WormholeRuntime({
      now: () => now,
      randomBytes: (size) =>
        Uint8Array.from({ length: size }, (_, index) => index),
    });

    expect(runtime.status()).toEqual({ enabled: false });
    const enabled = runtime.enable();
    expect(enabled).toMatchObject({
      enabled: true,
      username: "biunivers",
      path: "/wormhole/webdav/",
      enabledAt: new Date(1000).toISOString(),
    });
    expect(enabled.password).toMatch(/^[2-9A-HJ-NP-Za-km-z]{10}$/);
    now = 2000;
    expect(runtime.enable()).toEqual(enabled);
    expect(runtime.authenticate("biunivers", enabled.password!, "client"))
      .toBe(true);
  });

  it("rotates credentials, aborts requests and disables idempotently", () => {
    let seed = 0;
    const runtime = new WormholeRuntime({
      randomBytes: (size) =>
        Uint8Array.from({ length: size }, () => seed++),
    });
    const first = runtime.enable();
    const lease = runtime.registerRequest();
    const second = runtime.rotate();

    expect(second.password).not.toBe(first.password);
    expect(lease.signal.aborted).toBe(true);
    expect(runtime.authenticate("biunivers", first.password!, "client"))
      .toBe(false);
    expect(runtime.authenticate("biunivers", second.password!, "client"))
      .toBe(true);
    expect(runtime.disable()).toEqual({ enabled: false });
    expect(runtime.disable()).toEqual({ enabled: false });
    expect(() => runtime.registerRequest()).toThrowError(WormholeRuntimeError);
    expect(() => runtime.rotate()).toThrowError(WormholeRuntimeError);
  });

  it("rate limits repeated failures per source and clears them on success", () => {
    let now = 0;
    const runtime = new WormholeRuntime({
      now: () => now,
      randomBytes: (size) => new Uint8Array(size),
    });
    const enabled = runtime.enable();
    for (let index = 0; index < 10; index += 1) {
      expect(runtime.authenticate("biunivers", "wrong", "client")).toBe(false);
    }
    expect(runtime.authenticate("biunivers", enabled.password!, "client"))
      .toBe(false);
    now = 60_001;
    expect(runtime.authenticate("biunivers", enabled.password!, "client"))
      .toBe(true);
  });
});
