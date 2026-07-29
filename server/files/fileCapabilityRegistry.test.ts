import { describe, expect, it } from "vitest";
import {
  FileCapabilityError,
  FileCapabilityRegistry,
} from "./fileCapabilityRegistry.js";
import type { IndexedEntry } from "./entryIndex.js";

const file: IndexedEntry = {
  entryIdHex: "11".repeat(16),
  parentEntryIdHex: "22".repeat(16),
  name: "notes.md",
  kind: "file",
  createdAtMs: 1,
  mtimeMs: 2,
  content: {
    kind: "chunk",
    fidHex: "33".repeat(16),
    size: 42,
  },
};

function tokens() {
  let next = 0;
  return () => Buffer.alloc(32, ++next).toString("base64url");
}

function expectCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("Expected capability error.");
  } catch (error) {
    expect(error).toBeInstanceOf(FileCapabilityError);
    expect((error as FileCapabilityError).code).toBe(code);
  }
}

describe("FileCapabilityRegistry", () => {
  it("binds opaque handles to one app window instance", () => {
    const registry = new FileCapabilityRegistry({ randomToken: tokens() });
    const first = registry.createInstance("io.example.notes", "window-1");
    const second = registry.createInstance("io.example.notes", "window-2");
    const handle = registry.issueHandle(
      first.instanceToken,
      file,
      7,
      true,
    );

    expect(
      registry.authorizeHandle(first.instanceToken, handle.handleId, true),
    ).toEqual({
      appId: "io.example.notes",
      windowInstanceId: "window-1",
      entryIdHex: file.entryIdHex,
      writable: true,
      issuedAtRevision: 7,
      expectedContentFidHex: file.content?.fidHex,
    });
    expectCode(
      () => registry.authorizeHandle(second.instanceToken, handle.handleId),
      "HANDLE_NOT_FOUND",
    );
  });

  it("enforces read-only handles and hides internal content refs", () => {
    const registry = new FileCapabilityRegistry({ randomToken: tokens() });
    const instance = registry.createInstance(
      "io.example.notes",
      "window-1",
    );
    const handle = registry.issueHandle(
      instance.instanceToken,
      file,
      3,
      false,
    );

    expect(handle.metadata).toEqual({
      entryId: file.entryIdHex,
      name: "notes.md",
      kind: "file",
      size: 42,
      mtimeMs: 2,
      revision: 3,
    });
    expect(JSON.stringify(handle)).not.toContain(file.content?.fidHex);
    expectCode(
      () =>
        registry.authorizeHandle(
          instance.instanceToken,
          handle.handleId,
          true,
        ),
      "PERMISSION_DENIED",
    );
  });

  it("expires and revokes capabilities without persistence", () => {
    let now = 1_000;
    const registry = new FileCapabilityRegistry({
      now: () => now,
      randomToken: tokens(),
      instanceTtlMs: 100,
      handleTtlMs: 50,
    });
    const first = registry.createInstance("io.example.notes", "window-1");
    const firstHandle = registry.issueHandle(
      first.instanceToken,
      file,
      0,
      false,
    );
    now = 1_051;
    expectCode(
      () => registry.authorizeHandle(first.instanceToken, firstHandle.handleId),
      "HANDLE_EXPIRED",
    );

    const secondHandle = registry.issueHandle(
      first.instanceToken,
      file,
      0,
      false,
    );
    registry.closeInstance(first.instanceToken);
    expectCode(
      () => registry.authorizeHandle(first.instanceToken, secondHandle.handleId),
      "HANDLE_NOT_FOUND",
    );
  });

  it("bounds active instances and handles", () => {
    const registry = new FileCapabilityRegistry({
      randomToken: tokens(),
      maxInstances: 1,
      maxHandles: 1,
    });
    const instance = registry.createInstance(
      "io.example.notes",
      "window-1",
    );
    expectCode(
      () => registry.createInstance("io.example.notes", "window-2"),
      "CAPABILITY_LIMIT_REACHED",
    );
    registry.issueHandle(instance.instanceToken, file, 0, false);
    expectCode(
      () => registry.issueHandle(instance.instanceToken, file, 0, false),
      "CAPABILITY_LIMIT_REACHED",
    );
  });
});
