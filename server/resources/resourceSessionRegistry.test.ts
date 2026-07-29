import { describe, expect, it } from "vitest";
import type { IndexedEntry } from "../files/entryIndex.js";
import { ResourceSessionRegistry } from "./resourceSessionRegistry.js";

const appId = "io.example.player";
const otherAppId = "io.example.other";

function fileEntry(fidHex = "ab".repeat(16)): IndexedEntry {
  return {
    entryIdHex: "11".repeat(16),
    parentEntryIdHex: "22".repeat(16),
    name: "movie.mkv",
    kind: "file",
    createdAtMs: 100,
    mtimeMs: 123,
    content: {
      kind: "manifest",
      fidHex,
      size: 64 * 1024 * 1024 + 1,
    },
  };
}

function harness() {
  let now = 1_000_000;
  let tokenCounter = 0;
  const registry = new ResourceSessionRegistry({
    now: () => now,
    leaseTtlMs: 300_000,
    randomToken: () =>
      Buffer.alloc(32, (tokenCounter++ % 250) + 1).toString("base64url"),
  });
  return {
    registry,
    advance(milliseconds: number) {
      now += milliseconds;
    },
    now: () => now,
  };
}

describe("ResourceSessionRegistry", () => {
  it("issues a five-minute snapshot without exposing internal identities", () => {
    const { registry, now } = harness();
    const session = registry.issueFile(
      appId,
      fileEntry(),
      7,
      "read",
      "video/x-matroska",
    );

    expect(session).toMatchObject({
      access: "read",
      expiresAt: new Date(now() + 300_000).toISOString(),
      metadata: {
        name: "movie.mkv",
        size: 64 * 1024 * 1024 + 1,
        mtimeMs: 123,
        mediaType: "video/x-matroska",
      },
    });
    expect(session).not.toHaveProperty("entryIdHex");
    expect(session).not.toHaveProperty("content");

    expect(registry.authorize(appId, session.sessionId)).toMatchObject({
      entryIdHex: "11".repeat(16),
      content: { fidHex: "ab".repeat(16) },
      issuedAtRevision: 7,
    });
  });

  it("renews a deduplicated batch and isolates other apps", () => {
    const { registry, advance, now } = harness();
    const session = registry.issueFile(appId, fileEntry(), 1, "read");
    advance(60_000);

    expect(
      registry.renew(appId, [
        session.sessionId,
        session.sessionId,
        "invalid",
      ]),
    ).toEqual({
      renewed: [
        {
          sessionId: session.sessionId,
          expiresAt: new Date(now() + 300_000).toISOString(),
        },
      ],
      rejected: [
        {
          sessionId: "invalid",
          code: "RESOURCE_SESSION_NOT_FOUND",
        },
      ],
    });
    expect(registry.renew(otherAppId, [session.sessionId])).toEqual({
      renewed: [],
      rejected: [
        {
          sessionId: session.sessionId,
          code: "RESOURCE_SESSION_NOT_FOUND",
        },
      ],
    });
  });

  it("expires after 300 seconds and cannot be revived", () => {
    const { registry, advance } = harness();
    const session = registry.issueFile(appId, fileEntry(), 1, "read");
    advance(300_000);

    expect(registry.renew(appId, [session.sessionId])).toEqual({
      renewed: [],
      rejected: [
        {
          sessionId: session.sessionId,
          code: "RESOURCE_SESSION_EXPIRED",
        },
      ],
    });
    expect(() => registry.authorize(appId, session.sessionId)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_SESSION_NOT_FOUND" }),
    );
  });

  it("lets an accepted long use finish and renew after the expiry point", () => {
    const { registry, advance, now } = harness();
    const session = registry.issueFile(appId, fileEntry(), 1, "read");
    const use = registry.beginUse(appId, session.sessionId);
    advance(360_000);

    expect(() => registry.authorize(appId, session.sessionId)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_SESSION_EXPIRED" }),
    );
    registry.finishUse(use, true);
    expect(registry.authorize(appId, session.sessionId)).toMatchObject({
      metadata: {
        contentVersion: session.metadata.contentVersion,
      },
    });
    expect(registry.touch(appId, session.sessionId).expiresAt).toBe(
      new Date(now() + 300_000).toISOString(),
    );
  });

  it("enforces read/edit and advances an edit session after save", () => {
    const { registry } = harness();
    const read = registry.issueFile(appId, fileEntry(), 1, "read");
    expect(() =>
      registry.beginUse(appId, read.sessionId, "edit"),
    ).toThrowError(expect.objectContaining({ code: "RESOURCE_ACCESS_DENIED" }));

    const edit = registry.issueFile(appId, fileEntry(), 1, "edit");
    const updated = fileEntry("cd".repeat(16));
    updated.name = "renamed.mkv";
    updated.content!.size += 10;
    const advanced = registry.advanceAfterSave(
      appId,
      edit.sessionId,
      updated,
      2,
    );

    expect(advanced.metadata).toMatchObject({
      name: "renamed.mkv",
      size: 64 * 1024 * 1024 + 11,
    });
    expect(advanced.metadata.contentVersion).not.toBe(
      edit.metadata.contentVersion,
    );
    expect(registry.authorize(appId, edit.sessionId, "edit")).toMatchObject({
      expectedContentFidHex: "cd".repeat(16),
      issuedAtRevision: 2,
    });
  });

  it("converts a pending save target after its first successful save", () => {
    const { registry } = harness();
    const pending = registry.issuePendingFile(
      appId,
      "22".repeat(16),
      "new.txt",
      4,
      "text/plain",
    );
    expect(registry.authorize(appId, pending.sessionId)).toMatchObject({
      pendingParentEntryIdHex: "22".repeat(16),
      pendingName: "new.txt",
      content: undefined,
    });

    registry.advanceAfterSave(appId, pending.sessionId, fileEntry(), 5);
    expect(registry.authorize(appId, pending.sessionId)).toMatchObject({
      entryIdHex: "11".repeat(16),
      pendingParentEntryIdHex: undefined,
      pendingName: undefined,
    });
  });

  it("actively aborts every use when an app is revoked", () => {
    const { registry } = harness();
    const first = registry.issueFile(appId, fileEntry(), 1, "read");
    const second = registry.issueFile(appId, fileEntry(), 1, "edit");
    const firstUse = registry.beginUse(appId, first.sessionId);
    const secondUse = registry.beginUse(appId, second.sessionId, "edit");

    registry.revokeApp(appId);

    expect(firstUse.signal.aborted).toBe(true);
    expect(secondUse.signal.aborted).toBe(true);
    expect(() => registry.authorize(appId, first.sessionId)).toThrowError(
      expect.objectContaining({ code: "RESOURCE_SESSION_NOT_FOUND" }),
    );
  });

  it("makes release idempotent without affecting another app", () => {
    const { registry } = harness();
    const own = registry.issueFile(appId, fileEntry(), 1, "read");
    const other = registry.issueFile(otherAppId, fileEntry(), 1, "read");

    registry.release(appId, [own.sessionId, own.sessionId, other.sessionId]);
    registry.release(appId, [own.sessionId]);

    expect(registry.authorize(otherAppId, other.sessionId)).toBeDefined();
  });
});
