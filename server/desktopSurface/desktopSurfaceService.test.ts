// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "../apps/appStore.js";
import { EntryIndex, type IndexedEntry } from "../files/entryIndex.js";
import { DesktopSurfaceService } from "./desktopSurfaceService.js";
import { DesktopSurfaceStore } from "./desktopSurfaceStore.js";

const directories: string[] = [];
const surfaceStores: DesktopSurfaceStore[] = [];

afterEach(async () => {
  surfaceStores.splice(0).forEach((store) => store.close());
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "surface-service-"));
  directories.push(directory);
  const appStore = new AppStore(directory);
  await appStore.initialize();
  const surfaceStore = await DesktopSurfaceStore.open(
    join(directory, "desktop-surface.sqlite"),
  );
  surfaceStores.push(surfaceStore);
  let index = entryIndex("Draft.txt");
  const service = new DesktopSurfaceService({
    store: surfaceStore,
    appStore,
    appOrigin: "http://localhost:8081",
    internalApps: [],
    loadEntryIndex: async () => index,
  });
  await service.initialize();
  return {
    appStore,
    service,
    setIndex(next: EntryIndex) {
      index = next;
    },
  };
}

describe("DesktopSurfaceService lifecycle projection", () => {
  it("tracks a stable file entry through rename and removal", async () => {
    const { service, setIndex } = await fixture();
    const added = await service.add(
      { type: "file", handle: "22".repeat(16) },
      { x: 0, y: 0 },
      service.read().revision,
    );
    await expect(service.resolve(added)).resolves.toMatchObject({
      items: [{ resolved: { available: true, name: "Draft.txt" } }],
    });

    setIndex(entryIndex("Final.txt"));
    await expect(service.resolve()).resolves.toMatchObject({
      items: [{ resolved: { available: true, name: "Final.txt" } }],
    });

    setIndex(
      new EntryIndex(3, [
        directory("11".repeat(16), null, ""),
      ]),
    );
    await expect(service.resolve()).resolves.toMatchObject({
      items: [
        {
          resolved: {
            available: false,
            name: "Final.txt",
            reason: "文件或目录不存在",
          },
        },
      ],
    });
  });

  it("retains an app reference after the app is disabled", async () => {
    const { appStore, service } = await fixture();
    await appStore.write({
      schemaVersion: 1,
      apps: [
        {
          appId: "io.github.example.editor",
          repository: "https://github.com/example/editor",
          requestedRef: "main",
          commitSha: "a".repeat(40),
          version: "1.0.0",
          protocol: "biunivers.static-app/1",
          manifest: {
            formatVersion: 1,
            protocol: "biunivers.static-app/1",
            appId: "io.github.example.editor",
            version: "1.0.0",
            name: "Editor",
            license: "MIT",
            icon: "icon.svg",
            window: {
              defaultWidth: 640,
              defaultHeight: 480,
            },
            configuration: [],
          },
          configuration: {},
          status: "active",
          installedAt: "2026-07-29T00:00:00.000Z",
          updatedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
    });
    await service.add(
      { type: "app", handle: "io.github.example.editor" },
      { x: 0, y: 0 },
      service.read().revision,
    );
    await service.resolve();
    const state = await appStore.read();
    state.apps[0].status = "disabled";
    await appStore.write(state);

    await expect(service.resolve()).resolves.toMatchObject({
      items: [
        {
          target: {
            type: "app",
            handle: "io.github.example.editor",
          },
          resolved: {
            available: false,
            name: "Editor",
            reason: "应用不存在或未启用",
          },
        },
      ],
    });
  });
});

function entryIndex(fileName: string) {
  return new EntryIndex(2, [
    directory("11".repeat(16), null, ""),
    {
      entryIdHex: "22".repeat(16),
      parentEntryIdHex: "11".repeat(16),
      name: fileName,
      kind: "file",
      createdAtMs: 1,
      mtimeMs: 1,
      content: {
        kind: "chunk",
        fidHex: "33".repeat(16),
        size: 1,
      },
    },
  ]);
}

function directory(
  entryIdHex: string,
  parentEntryIdHex: string | null,
  name: string,
): IndexedEntry {
  return {
    entryIdHex,
    parentEntryIdHex,
    name,
    kind: "directory",
    createdAtMs: 1,
    mtimeMs: 1,
  };
}
