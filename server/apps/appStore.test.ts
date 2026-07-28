// @vitest-environment node

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore, type InstalledAppState } from "./appStore.js";

const temporaryDirectories: string[] = [];

async function createStore() {
  const directory = await mkdtemp(join(tmpdir(), "biunivers-store-"));
  temporaryDirectories.push(directory);
  const store = new AppStore(directory);
  await store.initialize();
  return store;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AppStore", () => {
  it("initializes the data layout with an empty state", async () => {
    const store = await createStore();

    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      apps: [],
    });
    await expect(readdir(store.dataDir)).resolves.toEqual(
      expect.arrayContaining(["apps", "staging", "state", "trash"]),
    );
  });

  it("atomically persists a valid state without leftover temp files", async () => {
    const store = await createStore();
    const state: InstalledAppState = {
      schemaVersion: 1,
      apps: [
        {
          appId: "io.github.example.hello",
          repository: "https://github.com/example/hello",
          requestedRef: "v1.0.0",
          commitSha: "0123456789abcdef",
          version: "1.0.0",
          protocol: "biunivers.static-app/1",
          manifest: {
            formatVersion: 1,
            protocol: "biunivers.static-app/1",
            appId: "io.github.example.hello",
            version: "1.0.0",
            name: "Hello",
            license: "MIT",
            icon: "icon.svg",
            window: {
              defaultWidth: 640,
              defaultHeight: 480,
            },
            configuration: [],
          },
          configuration: { greeting: "你好" },
          status: "active",
          installedAt: "2026-07-28T00:00:00.000Z",
          updatedAt: "2026-07-28T00:00:00.000Z",
        },
      ],
    };

    await store.write(state);

    await expect(store.read()).resolves.toEqual(state);
    expect(await readdir(join(store.dataDir, "state"))).toEqual([
      "installed-apps.json",
    ]);
  });

  it("rejects an invalid state before writing", async () => {
    const store = await createStore();

    await expect(
      store.write({ schemaVersion: 1, apps: [{}] } as InstalledAppState),
    ).rejects.toThrow("格式无效");
    await expect(store.read()).resolves.toEqual({
      schemaVersion: 1,
      apps: [],
    });
  });
});
