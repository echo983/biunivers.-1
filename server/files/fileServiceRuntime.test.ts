import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { FileServiceConfig } from "../config.js";
import {
  startFileService,
  type FileServiceObjectStoreHandle,
} from "./fileServiceRuntime.js";
import { LocalWormObjectStore } from "./localWormObjectStore.js";
import { FileContentStore } from "./fileContentStore.js";
import { FileSystemTransactions } from "./fileSystemTransactions.js";

const roots: string[] = [];

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "biunivers-runtime-"));
  roots.push(root);
  const config: FileServiceConfig = {
    initialize: true,
    databasePath: join(root, "data", "file-service.sqlite"),
    endpoint: "https://s3.example.test",
    region: "auto",
    bucket: "test",
    keyPrefix: "files",
    namespace: "users/alice",
    accessKeyId: "access",
    secretAccessKey: "secret",
    forcePathStyle: true,
    writerId: "test",
  };
  const createObjectStore = (): FileServiceObjectStoreHandle => ({
    store: new LocalWormObjectStore(join(root, "objects")),
    close() {},
  });
  return { config, createObjectStore };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("startFileService", () => {
  it("is disabled without configuration", async () => {
    await expect(startFileService(undefined)).resolves.toMatchObject({
      status: { mode: "disabled", writable: false },
    });
  });

  it("explicitly initializes once and normally restores validated state", async () => {
    const { config, createObjectStore } = await setup();
    const initialized = await startFileService(config, { createObjectStore });
    expect(initialized.status).toMatchObject({
      mode: "ready",
      writable: true,
      revision: 0,
    });
    initialized.close();

    const restored = await startFileService(
      { ...config, initialize: false },
      { createObjectStore },
    );
    expect(restored.status).toEqual(initialized.status);
    restored.close();
  });

  it("refuses repeated initialization without changing the existing Ref", async () => {
    const { config, createObjectStore } = await setup();
    const initialized = await startFileService(config, { createObjectStore });
    initialized.close();

    const repeated = await startFileService(config, { createObjectStore });
    expect(repeated.status).toMatchObject({
      mode: "offline",
      writable: false,
      code: "REF_ALREADY_EXISTS",
    });

    const restored = await startFileService(
      { ...config, initialize: false },
      { createObjectStore },
    );
    expect(restored.status).toMatchObject({ mode: "ready", revision: 0 });
    restored.close();
  });

  it("reports the current revision instead of the startup snapshot", async () => {
    const { config, createObjectStore } = await setup();
    const runtime = await startFileService(config, { createObjectStore });
    const content = await new FileContentStore(
      runtime.repository!,
    ).putBytes(Buffer.from("live"));
    await new FileSystemTransactions({
      refId: "main",
      repository: runtime.repository!,
      refStore: runtime.refStore!,
      writerId: "test",
    }).createFile({
      parentEntryIdHex: runtime.entryIndex!.rootEntryIdHex,
      name: "live.txt",
      content,
    });

    await expect(runtime.currentStatus()).resolves.toMatchObject({
      mode: "ready",
      revision: 1,
      rootEntryIdHex: runtime.entryIndex!.rootEntryIdHex,
    });
    runtime.close();
  });

  it("stays offline when an existing RefStore is missing", async () => {
    const { config, createObjectStore } = await setup();
    const runtime = await startFileService(
      { ...config, initialize: false },
      { createObjectStore },
    );

    expect(runtime.status).toEqual({
      mode: "offline",
      writable: false,
      code: "REFSTORE_MISSING",
      message:
        "RefStore is missing; restore it or run an explicit first-time initialization.",
    });
  });
});
