import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearResourceLaunch,
  consumeResourceLaunch,
  pendingResourceLaunch,
  queueResourceLaunch,
  resetResourceLaunchBrokerForTests,
  subscribeResourceLaunch,
} from "./launchBroker";

describe("resource launch broker", () => {
  beforeEach(resetResourceLaunchBrokerForTests);

  it("queues one launch and notifies current subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeResourceLaunch("notes", listener);
    queueResourceLaunch("notes", "a".repeat(43));
    expect(listener).toHaveBeenCalledOnce();
    expect(pendingResourceLaunch("notes")).toBe("a".repeat(43));
    unsubscribe();
  });

  it("rejects replacement and only consumes the matching launch", () => {
    queueResourceLaunch("notes", "a".repeat(43));
    expect(() =>
      queueResourceLaunch("notes", "b".repeat(43)),
    ).toThrow(/already has/);
    consumeResourceLaunch("notes", "b".repeat(43));
    expect(pendingResourceLaunch("notes")).toBe("a".repeat(43));
    consumeResourceLaunch("notes", "a".repeat(43));
    expect(pendingResourceLaunch("notes")).toBeUndefined();
  });

  it("clears a pending launch when its app window closes", () => {
    queueResourceLaunch("notes", "a".repeat(43));
    clearResourceLaunch("notes");
    expect(pendingResourceLaunch("notes")).toBeUndefined();
  });
});
