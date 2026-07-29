// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { InstalledAppRecord } from "../apps/appStore.js";
import { EntryIndex } from "../files/entryIndex.js";
import { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { OpenResourceResolver } from "./openResourceResolver.js";

function installed(
  appId: string,
  name: string,
  actions: Array<"open" | "edit">,
  status: "active" | "disabled" = "active",
): InstalledAppRecord {
  return {
    appId,
    repository: `https://github.com/example/${appId}`,
    requestedRef: "v1",
    commitSha: "0123456789abcdef",
    version: "1.0.0",
    protocol: "biunivers.static-app/1",
    manifest: {
      formatVersion: 1,
      protocol: "biunivers.static-app/1",
      appId,
      version: "1.0.0",
      name,
      license: "MIT",
      icon: "icon.svg",
      window: { defaultWidth: 640, defaultHeight: 480 },
      configuration: [],
    },
    openResource: {
      protocol: "biunivers.open-resource/1",
      handlers: [
        {
          id: "text",
          actions,
          extensions: [".txt"],
          access: actions.includes("edit") ? "read-write" : "read",
        },
      ],
    },
    configuration: {},
    status,
    installedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function setup(apps: InstalledAppRecord[]) {
  const capabilities = new FileCapabilityRegistry();
  const instanceToken = capabilities.createInstance(
    "system.files",
    "files-window",
  ).instanceToken;
  const index = new EntryIndex(4, [
    {
      entryIdHex: "10".repeat(16),
      parentEntryIdHex: null,
      name: "",
      kind: "directory",
      createdAtMs: 1,
      mtimeMs: 1,
    },
    {
      entryIdHex: "20".repeat(16),
      parentEntryIdHex: "10".repeat(16),
      name: "NOTE.TXT",
      kind: "file",
      createdAtMs: 1,
      mtimeMs: 1,
      content: { kind: "chunk", fidHex: "30".repeat(16), size: 4 },
    },
  ]);
  return {
    capabilities,
    instanceToken,
    resolver: new OpenResourceResolver({
      capabilities,
      appStore: { read: async () => ({ apps }) },
      loadIndex: async () => index,
    }),
  };
}

describe("OpenResourceResolver", () => {
  it("returns active edit candidates with normalized extension", async () => {
    const { resolver, instanceToken } = setup([
      installed("io.github.example.viewer", "Viewer", ["open"]),
      installed("io.github.example.notes", "Notes", ["open", "edit"]),
      installed(
        "io.github.example.disabled",
        "Disabled",
        ["open", "edit"],
        "disabled",
      ),
    ]);

    await expect(
      resolver.resolve(instanceToken, {
        entryId: "20".repeat(16),
        expectedRevision: 4,
        requestedAction: "edit",
      }),
    ).resolves.toMatchObject({
      extension: ".txt",
      effectiveAction: "edit",
      candidates: [{ appId: "io.github.example.notes" }],
    });
  });

  it("falls back from edit to open only when no edit candidate exists", async () => {
    const { resolver, instanceToken } = setup([
      installed("io.github.example.viewer", "Viewer", ["open"]),
    ]);
    await expect(
      resolver.resolve(instanceToken, {
        entryId: "20".repeat(16),
        expectedRevision: 4,
        requestedAction: "edit",
      }),
    ).resolves.toMatchObject({
      requestedAction: "edit",
      effectiveAction: "open",
      candidates: [{ appId: "io.github.example.viewer" }],
    });
  });

  it("rejects stale and non-file-manager requests", async () => {
    const { capabilities, resolver, instanceToken } = setup([]);
    await expect(
      resolver.resolve(instanceToken, {
        entryId: "20".repeat(16),
        expectedRevision: 3,
        requestedAction: "edit",
      }),
    ).rejects.toMatchObject({ code: "FILE_VERSION_CONFLICT" });
    const otherToken = capabilities.createInstance(
      "io.github.example.notes",
      "notes-window",
    ).instanceToken;
    await expect(
      resolver.resolve(otherToken, {
        entryId: "20".repeat(16),
        expectedRevision: 4,
        requestedAction: "open",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });
});
