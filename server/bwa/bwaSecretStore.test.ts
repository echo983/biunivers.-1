import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BwaSecretStore } from "./bwaSecretStore.js";

const roots: string[] = [];
const instanceId = "11".repeat(16);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("BwaSecretStore", () => {
  it("atomically persists only requested instance secrets with restricted modes", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-secrets-"));
    roots.push(root);
    const path = join(root, "private", "bwa-secrets.json");
    const store = new BwaSecretStore(path);
    await store.initialize();
    await store.replace(instanceId, { API_TOKEN: "very-secret", SECOND: "two" });

    expect(await store.read(instanceId, ["SECOND", "API_TOKEN"])).toEqual({
      SECOND: "two",
      API_TOKEN: "very-secret",
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, "private"))).mode & 0o777).toBe(0o700);
    expect(await readFile(path, "utf8")).toContain("very-secret");
    await expect(store.read(instanceId, ["MISSING"])).rejects.toThrow("no stored value");
  });

  it("deletes and prunes unreachable secret groups without exposing values", async () => {
    const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-secrets-"));
    roots.push(root);
    const store = new BwaSecretStore(join(root, "private", "bwa-secrets.json"));
    await store.initialize();
    await store.replace(instanceId, { TOKEN: "one" });
    await store.replace("22".repeat(16), { TOKEN: "two" });
    expect(await store.prune(new Set([instanceId]))).toBe(1);
    await store.deleteInstance(instanceId);
    await expect(store.read(instanceId, ["TOKEN"])).rejects.toThrow("no stored value");
  });
});
