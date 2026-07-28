// @vitest-environment node

import { describe, expect, it } from "vitest";
import { OperationLock } from "./operationLock.js";

describe("OperationLock", () => {
  it("runs operations serially and continues after a failure", async () => {
    const lock = new OperationLock();
    const events: string[] = [];

    const first = lock.run(async () => {
      events.push("first:start");
      await Promise.resolve();
      events.push("first:end");
      throw new Error("expected");
    });
    const second = lock.run(async () => {
      events.push("second");
      return 2;
    });

    await expect(first).rejects.toThrow("expected");
    await expect(second).resolves.toBe(2);
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});
