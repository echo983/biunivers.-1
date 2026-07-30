import { describe, expect, it } from "vitest";
import { WormholeLockRegistry } from "./wormholeLockRegistry.js";

describe("WormholeLockRegistry", () => {
  it("protects a locked path until the matching token is supplied", () => {
    const locks = new WormholeLockRegistry();
    const lock = locks.lock("/docs/note.txt", "tester");
    expect(() => locks.assertAllowed("/docs/note.txt", "")).toThrow();
    expect(() => locks.assertAllowed("/docs/note.txt", lock.token)).not.toThrow();
    locks.unlock("/docs/note.txt", lock.token);
    expect(() => locks.assertAllowed("/docs/note.txt", "")).not.toThrow();
  });
});
