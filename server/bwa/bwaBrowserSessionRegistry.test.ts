import { describe, expect, it } from "vitest";
import {
  BwaBrowserSessionRegistry,
  bwaSessionCookieName,
} from "./bwaBrowserSessionRegistry.js";

const first = "11".repeat(16);
const second = "22".repeat(16);

describe("BwaBrowserSessionRegistry", () => {
  it("consumes a bootstrap exactly once and binds the session to one Instance", () => {
    let now = 100;
    let byte = 1;
    const registry = new BwaBrowserSessionRegistry({
      now: () => now,
      random: (bytes) => Buffer.alloc(bytes, byte++),
      ticketTtlMs: 30,
      sessionIdleMs: 100,
    });
    const issued = registry.issueBootstrap(first);
    const consumed = registry.consumeBootstrap(first, issued.ticket);
    expect(() => registry.consumeBootstrap(first, issued.ticket)).toThrowError(
      expect.objectContaining({ code: "BOOTSTRAP_INVALID" }),
    );
    expect(() => registry.authorize(second, consumed.session)).toThrowError(
      expect.objectContaining({ code: "SESSION_INVALID" }),
    );
    expect(() => registry.authorize(first, consumed.session)).not.toThrow();
    now = 201;
    expect(() => registry.authorize(first, consumed.session)).toThrowError(
      expect.objectContaining({ code: "SESSION_INVALID" }),
    );
  });

  it("expires tickets and revokes every token for one Instance", () => {
    let now = 100;
    let byte = 3;
    const registry = new BwaBrowserSessionRegistry({
      now: () => now,
      random: (bytes) => Buffer.alloc(bytes, byte++),
      ticketTtlMs: 10,
    });
    const expired = registry.issueBootstrap(first);
    now = 110;
    expect(() => registry.consumeBootstrap(first, expired.ticket)).toThrowError(
      expect.objectContaining({ code: "BOOTSTRAP_INVALID" }),
    );
    const active = registry.issueBootstrap(first);
    const session = registry.consumeBootstrap(first, active.ticket).session;
    registry.revokeInstance(first);
    expect(() => registry.authorize(first, session)).toThrowError(
      expect.objectContaining({ code: "SESSION_INVALID" }),
    );
  });

  it("uses a __Host cookie only when Secure can be satisfied", () => {
    expect(bwaSessionCookieName("https://apps.example.test")).toBe(
      "__Host-biunivers-bwa",
    );
    expect(bwaSessionCookieName("http://localhost:8081")).toBe(
      "biunivers-bwa-session",
    );
  });
});
