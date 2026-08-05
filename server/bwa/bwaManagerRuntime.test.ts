// @vitest-environment node

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import { BwaManagerRuntime } from "./bwaManagerRuntime.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("BwaManagerRuntime", () => {
  it("initializes the private store and assembles host proxy services without contacting Runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-manager-"));
    roots.push(root);
    const refStore = {
      listBwaApplications: vi.fn().mockReturnValue([]),
    } as unknown as SqliteRefStore;
    const manager = await BwaManagerRuntime.create({
      config: {
        runtimeSocketPath: join(root, "runtime.sock"),
        runtimeAuthenticationTokenHex: "11".repeat(32),
        secretStorePath: join(root, "private", "bwa-secrets.json"),
      },
      appOrigin: "http://localhost:8081",
      repository: {} as ImmutableObjectRepository,
      refStore,
      writerId: "test-writer",
    });
    try {
      expect(manager.httpProxy).toBeTypeOf("function");
      expect(manager.websocketProxy).toBeTypeOf("function");
      expect(JSON.parse(await readFile(join(root, "private", "bwa-secrets.json"), "utf8")))
        .toEqual({ schemaVersion: 2, values: {}, applicationValues: {} });
    } finally {
      manager.close();
    }
  });
});
