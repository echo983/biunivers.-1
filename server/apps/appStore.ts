import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AppManifest } from "../manifests/types.js";
import { readJsonFile, writeJsonFileAtomic } from "../storage/atomicJson.js";

export interface InstalledAppRecord {
  appId: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  version: string;
  protocol: "biunivers.static-app/1";
  manifest: AppManifest;
  configuration: Record<string, string | number | boolean>;
  status: "active" | "disabled";
  installedAt: string;
  updatedAt: string;
}

export interface InstalledAppState {
  schemaVersion: 1;
  apps: InstalledAppRecord[];
}

const EMPTY_STATE: InstalledAppState = {
  schemaVersion: 1,
  apps: [],
};

function validateState(value: InstalledAppState) {
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.apps) ||
    value.apps.some(
      (app) =>
        !app ||
        typeof app.appId !== "string" ||
        !app.manifest ||
        typeof app.manifest.name !== "string" ||
        (app.status !== "active" && app.status !== "disabled"),
    )
  ) {
    throw new Error("installed-apps.json 格式无效");
  }
  return value;
}

export class AppStore {
  readonly statePath: string;

  constructor(readonly dataDir: string) {
    this.statePath = join(dataDir, "state", "installed-apps.json");
  }

  async initialize() {
    await Promise.all([
      mkdir(join(this.dataDir, "apps"), { recursive: true }),
      mkdir(join(this.dataDir, "staging"), { recursive: true }),
      mkdir(join(this.dataDir, "trash"), { recursive: true }),
    ]);

    try {
      await access(this.statePath);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
      await writeJsonFileAtomic(this.statePath, EMPTY_STATE);
    }

    return this.read();
  }

  async read() {
    return validateState(await readJsonFile<InstalledAppState>(this.statePath));
  }

  async write(state: InstalledAppState) {
    validateState(state);
    await writeJsonFileAtomic(this.statePath, state);
  }
}
