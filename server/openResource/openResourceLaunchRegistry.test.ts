// @vitest-environment node

import { describe, expect, it } from "vitest";
import { OpenResourceLaunchRegistry } from "./openResourceLaunchRegistry.js";

const token = (character: string) => character.repeat(43);
const input = {
  targetAppId: "io.github.example.notes",
  handlerId: "text",
  entryId: "10".repeat(16),
  expectedRevision: 3,
  action: "edit" as const,
  writable: true,
};

describe("OpenResourceLaunchRegistry", () => {
  it("creates and consumes one launch for the target app", () => {
    const registry = new OpenResourceLaunchRegistry({
      now: () => 100,
      randomToken: () => token("a"),
    });
    const created = registry.create(input);
    expect(created).toEqual({
      launchId: token("a"),
      expiresAt: new Date(300_100).toISOString(),
    });
    expect(
      registry.consume(created.launchId, input.targetAppId),
    ).toMatchObject(input);
    expect(() =>
      registry.consume(created.launchId, input.targetAppId),
    ).toThrowError(expect.objectContaining({ code: "NO_LAUNCH_CONTEXT" }));
  });

  it("does not reveal or consume a launch for another app", () => {
    const registry = new OpenResourceLaunchRegistry({
      randomToken: () => token("a"),
    });
    const created = registry.create(input);
    expect(() =>
      registry.consume(created.launchId, "io.github.example.attacker"),
    ).toThrowError(expect.objectContaining({ code: "NO_LAUNCH_CONTEXT" }));
    expect(
      registry.consume(created.launchId, input.targetAppId),
    ).toMatchObject(input);
  });

  it("enforces expiry, per-app busy and global capacity", () => {
    let now = 0;
    let next = 0;
    const registry = new OpenResourceLaunchRegistry({
      now: () => now,
      ttlMs: 5,
      maxLaunches: 1,
      randomToken: () => token(next++ === 0 ? "a" : "b"),
    });
    const created = registry.create(input);
    expect(() => registry.create(input)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_OPEN_BUSY" }),
    );
    expect(() =>
      registry.create({ ...input, targetAppId: "io.github.example.other" }),
    ).toThrowError(
      expect.objectContaining({ code: "CAPABILITY_LIMIT_REACHED" }),
    );
    now = 5;
    expect(() =>
      registry.consume(created.launchId, input.targetAppId),
    ).toThrowError(
      expect.objectContaining({ code: "LAUNCH_CONTEXT_EXPIRED" }),
    );
    expect(
      registry.create({ ...input, targetAppId: "io.github.example.other" }),
    ).toMatchObject({ launchId: token("b") });
  });

  it("cancels pending launches when the target closes or is disabled", () => {
    const registry = new OpenResourceLaunchRegistry({
      randomToken: () => token("a"),
    });
    const created = registry.create(input);
    registry.cancelTarget(input.targetAppId);
    expect(() =>
      registry.consume(created.launchId, input.targetAppId),
    ).toThrowError(expect.objectContaining({ code: "NO_LAUNCH_CONTEXT" }));
  });
});
