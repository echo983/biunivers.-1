// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import type { InstalledAppRecord } from "../apps/appStore.js";
import { EntryIndex } from "../files/entryIndex.js";
import { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { OpenResourceLaunchRegistry } from "./openResourceLaunchRegistry.js";
import { OpenResourceLaunchService } from "./openResourceLaunchService.js";
import type { PublicResourceSession } from "../resources/resourceSessionRegistry.js";

const appId = "io.github.example.notes";
const entryId = "20".repeat(16);

function installed(
  status: "active" | "disabled" = "active",
): InstalledAppRecord {
  return {
    appId,
    repository: "https://github.com/example/notes",
    requestedRef: "v1",
    commitSha: "01".repeat(20),
    version: "1.0.0",
    protocol: "biunivers.static-app/1",
    manifest: {
      formatVersion: 1,
      protocol: "biunivers.static-app/1",
      appId,
      version: "1.0.0",
      name: "Notes",
      license: "MIT",
      icon: "icon.svg",
      window: { defaultWidth: 640, defaultHeight: 480 },
      configuration: [],
    },
    openResource: {
      protocol: "biunivers.open-resource/1.1",
      handlers: [
        {
          id: "text",
          actions: ["open", "edit"],
          extensions: [".txt"],
          access: "read-write",
          multiple: true,
        },
      ],
    },
    configuration: {},
    status,
    installedAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function setup(resourceSessionService?: {
  issueFile: (
    instanceToken: string,
    entryId: string,
    access: "read" | "edit",
  ) => Promise<PublicResourceSession>;
  issueFiles?: (
    instanceToken: string,
    entryIds: readonly string[],
    handlerId?: string,
    expectedRevision?: number,
  ) => Promise<PublicResourceSession[]>;
}) {
  const capabilities = new FileCapabilityRegistry();
  const launches = new OpenResourceLaunchRegistry();
  const apps = [installed()];
  let index = new EntryIndex(3, [
    {
      entryIdHex: "10".repeat(16),
      parentEntryIdHex: null,
      name: "",
      kind: "directory",
      createdAtMs: 1,
      mtimeMs: 1,
    },
    {
      entryIdHex: entryId,
      parentEntryIdHex: "10".repeat(16),
      name: "note.txt",
      kind: "file",
      createdAtMs: 1,
      mtimeMs: 1,
      content: { kind: "chunk", fidHex: "30".repeat(16), size: 4 },
    },
    {
      entryIdHex: "21".repeat(16),
      parentEntryIdHex: "10".repeat(16),
      name: "second.txt",
      kind: "file",
      createdAtMs: 1,
      mtimeMs: 1,
      content: { kind: "chunk", fidHex: "31".repeat(16), size: 5 },
    },
  ]);
  const service = new OpenResourceLaunchService({
    capabilities,
    launches,
    appStore: { read: async () => ({ apps }) },
    resourceSessionService,
    loadIndex: async () => index,
  });
  return {
    apps,
    capabilities,
    service,
    setRevision(revision: number) {
      index = new EntryIndex(revision, [
        ...["10", "20"].map((prefix, itemIndex) =>
          itemIndex === 0
            ? {
                entryIdHex: prefix.repeat(16),
                parentEntryIdHex: null,
                name: "",
                kind: "directory" as const,
                createdAtMs: 1,
                mtimeMs: 1,
              }
            : {
                entryIdHex: prefix.repeat(16),
                parentEntryIdHex: "10".repeat(16),
                name: "note.txt",
                kind: "file" as const,
                createdAtMs: 1,
                mtimeMs: 1,
                content: {
                  kind: "chunk" as const,
                  fidHex: "30".repeat(16),
                  size: 4,
                },
              },
        ),
      ]);
    },
  };
}

describe("OpenResourceLaunchService", () => {
  it("creates for system.files and claims as the target app", async () => {
    const { capabilities, service } = setup();
    const source = capabilities.createInstance(
      "system.files",
      "files-window",
    ).instanceToken;
    const target = capabilities.createInstance(
      appId,
      "notes-window",
    ).instanceToken;
    const created = await service.create(source, {
      entryId,
      expectedRevision: 3,
      targetAppId: appId,
      handlerId: "text",
      action: "edit",
    });
    const context = await service.claim(target, created.launchId);
    expect(context).toMatchObject({
      action: "edit",
      resource: {
        name: "note.txt",
        permissions: ["read", "write"],
      },
    });
    expect(
      capabilities.authorizeHandle(
        target,
        context.resource.handleId,
        true,
      ),
    ).toMatchObject({ appId, entryIdHex: entryId, writable: true });
  });

  it("rejects cross-app claims without consuming the target launch", async () => {
    const { capabilities, service } = setup();
    const source = capabilities.createInstance(
      "system.files",
      "files-window",
    ).instanceToken;
    const target = capabilities.createInstance(
      appId,
      "notes-window",
    ).instanceToken;
    const attacker = capabilities.createInstance(
      "io.github.example.attacker",
      "attacker-window",
    ).instanceToken;
    const created = await service.create(source, {
      entryId,
      expectedRevision: 3,
      targetAppId: appId,
      handlerId: "text",
      action: "open",
    });
    await expect(
      service.claim(attacker, created.launchId),
    ).rejects.toMatchObject({ code: "NO_LAUNCH_CONTEXT" });
    await expect(service.claim(target, created.launchId)).resolves.toMatchObject({
      resource: { permissions: ["read"] },
    });
  });

  it("lets the new protocol consume a launch exactly once", async () => {
    const issueFile = vi.fn().mockResolvedValue({
      sessionId: "session-id",
      access: "edit",
    });
    const { capabilities, service } = setup({ issueFile });
    const source = capabilities.createInstance(
      "system.files",
      "files-window",
    ).instanceToken;
    const target = capabilities.createInstance(
      appId,
      "notes-window",
    ).instanceToken;
    const created = await service.create(source, {
      entryId,
      expectedRevision: 3,
      targetAppId: appId,
      handlerId: "text",
      action: "edit",
    });
    await expect(
      service.claimResourceSession(target, created.launchId),
    ).resolves.toMatchObject({
      action: "edit",
      resource: { sessionId: "session-id", access: "edit" },
    });
    expect(issueFile).toHaveBeenCalledWith(target, entryId, "edit");
    await expect(
      service.claim(target, created.launchId),
    ).rejects.toMatchObject({ code: "NO_LAUNCH_CONTEXT" });
  });

  it("creates and claims an ordered multi-resource launch", async () => {
    const resources = [
      { sessionId: "first", access: "read" },
      { sessionId: "second", access: "read" },
    ] as PublicResourceSession[];
    const issueFiles = vi.fn().mockResolvedValue(resources);
    const issueFile = vi.fn();
    const { capabilities, service } = setup({ issueFile, issueFiles });
    const source = capabilities.createInstance(
      "system.files",
      "files-window",
    ).instanceToken;
    const target = capabilities.createInstance(
      appId,
      "notes-window",
    ).instanceToken;
    const entryIds = [entryId, "21".repeat(16)];
    const created = await service.createMany(source, {
      entryIds,
      expectedRevision: 3,
      targetAppId: appId,
      handlerId: "text",
      action: "open",
    });
    await expect(
      service.claimResourceSession(target, created.launchId),
    ).resolves.toEqual({ action: "open", resources });
    expect(issueFiles).toHaveBeenCalledWith(target, entryIds, "text", 3);
    expect(issueFile).not.toHaveBeenCalled();
  });

  it("consumes safely when revision or handler changes before claim", async () => {
    const { apps, capabilities, service, setRevision } = setup();
    const source = capabilities.createInstance(
      "system.files",
      "files-window",
    ).instanceToken;
    const target = capabilities.createInstance(
      appId,
      "notes-window",
    ).instanceToken;
    const stale = await service.create(source, {
      entryId,
      expectedRevision: 3,
      targetAppId: appId,
      handlerId: "text",
      action: "edit",
    });
    setRevision(4);
    await expect(service.claim(target, stale.launchId)).rejects.toMatchObject({
      code: "FILE_VERSION_CONFLICT",
    });

    setRevision(3);
    const disabled = await service.create(source, {
      entryId,
      expectedRevision: 3,
      targetAppId: appId,
      handlerId: "text",
      action: "open",
    });
    apps[0] = installed("disabled");
    await expect(service.claim(target, disabled.launchId)).rejects.toMatchObject({
      code: "HANDLER_NOT_AVAILABLE",
    });
  });
});
