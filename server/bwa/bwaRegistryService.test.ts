import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BwaImageInspection } from "../computeRuntime/dockerImageAdapter.js";
import { SqliteRefStore, type CreateWorkspaceInput } from "../files/sqliteRefStore.js";
import { BwaRegistryService } from "./bwaRegistryService.js";
import { BwaSecretStore } from "./bwaSecretStore.js";

const roots: string[] = [];
const now = 1_785_400_000_000;
const workspaceIdHex = "22".repeat(16);
const instanceIdHex = "33".repeat(16);
const digest = `sha256:${"a".repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("BwaRegistryService", () => {
  it("installs a fixed image, binds state, and keeps secret values outside RefStore", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-registry-"));
    roots.push(root);
    const databasePath = join(root, "refstore.sqlite");
    const secretPath = join(root, "private", "bwa-secrets.json");
    const refStore = await SqliteRefStore.initialize(databasePath);
    seedWorkspace(refStore);
    const secrets = new BwaSecretStore(secretPath);
    await secrets.initialize();
    const images = {
      pullAndInspect: vi.fn().mockResolvedValue(imageInspection()),
      inspectInstalled: vi.fn().mockResolvedValue(imageInspection()),
    };
    const registry = new BwaRegistryService({
      refStore,
      secrets,
      images,
      now: () => now,
      randomId: () => Buffer.from(instanceIdHex, "hex"),
    });

    const application = await registry.install("ghcr.io/echo983/probe:latest");
    expect(application).toMatchObject({
      applicationId: "ghcr.io/echo983/probe",
      installedDigest: digest,
      description: "Probe application",
      defaultInstanceIdHex: null,
    });
    const instance = registry.createInstance({
      applicationId: application.applicationId,
      workspaceIdHex,
      displayName: "Probe state",
    });
    expect(instance.instanceIdHex).toBe(instanceIdHex);
    await registry.replaceEnvironment(
      instanceIdHex,
      { MODE: "safe" },
      { API_TOKEN: "never-in-sqlite" },
    );
    expect(await registry.resolveEnvironment(instanceIdHex)).toEqual({
      API_TOKEN: "never-in-sqlite",
      MODE: "safe",
    });
    expect(refStore.listBwaEnvironment(instanceIdHex)).toEqual([
      { name: "API_TOKEN", value: null, sensitive: true },
      { name: "MODE", value: "safe", sensitive: false },
    ]);
    expect(await registry.verifyInstalled(application.applicationId)).toMatchObject({ digest });
    refStore.close();

    const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(databasePath));
    expect(bytes.includes(Buffer.from("never-in-sqlite"))).toBe(false);
    const reopened = await SqliteRefStore.openExisting(databasePath);
    expect(reopened.getBwaApplication(application.applicationId).defaultInstanceIdHex).toBe(
      instanceIdHex,
    );
    expect(reopened.getBwaInstance(instanceIdHex).workspaceIdHex).toBe(workspaceIdHex);
    reopened.close();
  });

  it("fails closed on missing protocol metadata and missing secret values", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-registry-"));
    roots.push(root);
    const refStore = await SqliteRefStore.initialize(join(root, "refstore.sqlite"));
    seedWorkspace(refStore);
    const secrets = new BwaSecretStore(join(root, "private", "bwa-secrets.json"));
    await secrets.initialize();
    const invalid = imageInspection();
    delete invalid.labels["io.biunivers.workspace-application.protocol"];
    const registry = new BwaRegistryService({
      refStore,
      secrets,
      images: {
        pullAndInspect: vi.fn().mockResolvedValue(invalid),
        inspectInstalled: vi.fn(),
      },
      now: () => now,
    });
    await expect(registry.install("ghcr.io/echo983/probe")).rejects.toMatchObject({
      code: "BWA_PROTOCOL_UNSUPPORTED",
    });
    refStore.close();
  });
});

function seedWorkspace(store: SqliteRefStore): void {
  const main = {
    refId: "main",
    lineageIdHex: "10".repeat(16),
    headFidHex: "11".repeat(16),
    revision: 0,
    updatedAtMs: now - 2,
  };
  store.createRef(main);
  const input: CreateWorkspaceInput = {
    workspaceIdHex,
    refId: `ws-${workspaceIdHex}`,
    name: "Probe workspace",
    sourceRefId: "main",
    sourceHeadFidHex: main.headFidHex,
    baselineHeadFidHex: "21".repeat(16),
    state: "READY",
    retention: "KEPT",
    activeWriteRunIdHex: null,
    createdAtMs: now - 1,
    updatedAtMs: now - 1,
    ref: {
      refId: `ws-${workspaceIdHex}`,
      lineageIdHex: "20".repeat(16),
      headFidHex: "21".repeat(16),
      revision: 0,
      updatedAtMs: now - 1,
    },
  };
  store.createWorkspace(input);
}

function imageInspection(): BwaImageInspection {
  return {
    canonicalRepository: "ghcr.io/echo983/probe",
    digest,
    imageReference: `ghcr.io/echo983/probe@${digest}`,
    labels: {
      "io.biunivers.workspace-application.protocol": "1",
      "org.opencontainers.image.title": "Probe",
      "org.opencontainers.image.description": "Probe application",
      "org.opencontainers.image.source": "https://github.com/echo983/probe",
      "org.opencontainers.image.version": "1.0.0",
    },
    entrypoint: ["/app/start"],
    cmd: [],
    architecture: "amd64",
    os: "linux",
  };
}
