import { randomBytes } from "node:crypto";
import type {
  BwaApplicationRecord,
  BwaEnvironmentVariable,
  BwaInstanceRecord,
  BwaStartupPolicy,
  SqliteRefStore,
} from "../files/sqliteRefStore.js";
import type { BwaImageInspection } from "../computeRuntime/dockerImageAdapter.js";
import type { BwaSecretStore } from "./bwaSecretStore.js";

const PROTOCOL_LABEL = "io.biunivers.workspace-application.protocol";
const DESCRIPTION_LABEL = "org.opencontainers.image.description";
const SOURCE_LABEL = "org.opencontainers.image.source";

export class BwaRegistryError extends Error {
  constructor(
    public readonly code:
      | "BWA_PROTOCOL_UNSUPPORTED"
      | "IMAGE_INSPECTION_INVALID"
      | "APPLICATION_DISABLED"
      | "SECRET_VALUE_MISSING",
    message: string,
  ) {
    super(message);
    this.name = "BwaRegistryError";
  }
}

export interface BwaImageClient {
  pullAndInspect(reference: string): Promise<BwaImageInspection>;
  inspectInstalled(imageReference: string): Promise<BwaImageInspection>;
}

export interface BlankInstanceCreator {
  create(input: {
    applicationId: string;
    workspaceName: string;
    instanceName: string;
    startupPolicy?: BwaStartupPolicy;
  }): Promise<{ workspace: unknown; instance: BwaInstanceRecord }>;
}

export class BwaRegistryService {
  readonly #refStore: SqliteRefStore;
  readonly #secrets: BwaSecretStore;
  readonly #images: BwaImageClient;
  readonly #now: () => number;
  readonly #randomId: () => Buffer;
  readonly #blankCreator?: BlankInstanceCreator;

  constructor(options: {
    refStore: SqliteRefStore;
    secrets: BwaSecretStore;
    images: BwaImageClient;
    now?: () => number;
    randomId?: () => Buffer;
    blankCreator?: BlankInstanceCreator;
  }) {
    this.#refStore = options.refStore;
    this.#secrets = options.secrets;
    this.#images = options.images;
    this.#now = options.now ?? Date.now;
    this.#randomId = options.randomId ?? (() => randomBytes(16));
    this.#blankCreator = options.blankCreator;
  }

  async install(reference: string): Promise<BwaApplicationRecord> {
    const inspection = await this.#images.pullAndInspect(reference);
    const metadata = validateInspection(inspection);
    const now = this.#timestamp();
    return this.#refStore.createBwaApplication({
      applicationId: inspection.canonicalRepository,
      installedDigest: inspection.digest,
      previousDigest: null,
      protocolVersion: 1,
      title: metadata.title,
      description: metadata.description,
      sourceUrl: metadata.sourceUrl,
      imageVersion: metadata.version,
      imageRevision: metadata.revision,
      imageLicenses: metadata.licenses,
      enabled: true,
      defaultInstanceIdHex: null,
      createdAtMs: now,
      updatedAtMs: now,
    });
  }

  async verifyInstalled(applicationId: string): Promise<BwaImageInspection> {
    const application = this.#refStore.getBwaApplication(applicationId);
    const inspection = await this.#images.inspectInstalled(
      `${application.applicationId}@${application.installedDigest}`,
    );
    validateInspection(inspection);
    return inspection;
  }

  createInstance(input: {
    applicationId: string;
    workspaceIdHex: string;
    displayName: string;
    startupPolicy?: BwaStartupPolicy;
  }): BwaInstanceRecord {
    const application = this.#refStore.getBwaApplication(input.applicationId);
    if (!application.enabled) {
      throw new BwaRegistryError("APPLICATION_DISABLED", "Application is disabled.");
    }
    const now = this.#timestamp();
    const id = this.#randomId();
    if (id.byteLength !== 16 || id.every((byte) => byte === 0)) {
      throw new Error("BWA Instance ID generation failed.");
    }
    return this.#refStore.createBwaInstance({
      instanceIdHex: id.toString("hex"),
      applicationId: input.applicationId,
      workspaceIdHex: input.workspaceIdHex,
      desiredState: "STOPPED",
      startupPolicy: input.startupPolicy ?? "MANUAL",
      displayName: input.displayName,
      createdAtMs: now,
      updatedAtMs: now,
    });
  }

  async createBlankInstance(input: {
    applicationId: string;
    name: string;
    startupPolicy?: BwaStartupPolicy;
  }): Promise<BwaInstanceRecord> {
    if (!this.#blankCreator) throw new Error("Blank BWA Instance creation is unavailable.");
    const result = await this.#blankCreator.create({
      applicationId: input.applicationId,
      workspaceName: input.name,
      instanceName: input.name,
      ...(input.startupPolicy ? { startupPolicy: input.startupPolicy } : {}),
    });
    return result.instance;
  }

  async replaceEnvironment(
    instanceIdHex: string,
    ordinary: Record<string, string>,
    sensitive: Record<string, string>,
  ): Promise<BwaEnvironmentVariable[]> {
    validateEnvironmentInput(ordinary, sensitive);
    const variables: BwaEnvironmentVariable[] = [
      ...Object.entries(ordinary).map(([name, value]) => ({
        name,
        value,
        sensitive: false,
      })),
      ...Object.keys(sensitive).map((name) => ({
        name,
        value: null,
        sensitive: true,
      })),
    ];
    await this.#secrets.replace(instanceIdHex, sensitive);
    return this.#refStore.replaceBwaEnvironment(instanceIdHex, variables);
  }

  async resolveEnvironment(instanceIdHex: string): Promise<Record<string, string>> {
    const variables = this.#refStore.listBwaEnvironment(instanceIdHex);
    const sensitiveNames = variables.filter((item) => item.sensitive).map((item) => item.name);
    let sensitive: Record<string, string>;
    try {
      sensitive = await this.#secrets.read(instanceIdHex, sensitiveNames);
    } catch {
      throw new BwaRegistryError(
        "SECRET_VALUE_MISSING",
        "One or more sensitive variables have no stored value.",
      );
    }
    return Object.fromEntries(
      variables.map((item) => [item.name, item.sensitive ? sensitive[item.name]! : item.value!]),
    );
  }

  async deleteInstancePreservingWorkspace(instanceIdHex: string) {
    const workspace = this.#refStore.deleteBwaInstancePreservingWorkspace(instanceIdHex);
    await this.#secrets.deleteInstance(instanceIdHex);
    return workspace;
  }

  async pruneOrphanSecrets(): Promise<number> {
    const reachable = new Set(
      this.#refStore
        .listBwaApplications()
        .flatMap((application) => this.#refStore.listBwaInstances(application.applicationId))
        .map((instance) => instance.instanceIdHex),
    );
    return await this.#secrets.prune(reachable);
  }

  #timestamp(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("BWA timestamp is invalid.");
    return now;
  }
}

function validateInspection(inspection: BwaImageInspection): {
  title: string;
  description: string;
  sourceUrl: string;
  version: string | null;
  revision: string | null;
  licenses: string | null;
} {
  if (inspection.labels[PROTOCOL_LABEL] !== "1") {
    throw new BwaRegistryError(
      "BWA_PROTOCOL_UNSUPPORTED",
      "Image does not declare Biunivers Workspace Application Protocol v1.",
    );
  }
  const description = requiredText(inspection.labels[DESCRIPTION_LABEL], 2048);
  const sourceUrl = inspection.labels[SOURCE_LABEL];
  try {
    const parsed = new URL(sourceUrl ?? "");
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error();
  } catch {
    throw invalidInspection();
  }
  const title = optionalText(
    inspection.labels["org.opencontainers.image.title"],
    256,
  ) ?? inspection.canonicalRepository.slice(inspection.canonicalRepository.lastIndexOf("/") + 1);
  return {
    title,
    description,
    sourceUrl: sourceUrl!,
    version: optionalText(inspection.labels["org.opencontainers.image.version"], 512),
    revision: optionalText(inspection.labels["org.opencontainers.image.revision"], 512),
    licenses: optionalText(inspection.labels["org.opencontainers.image.licenses"], 512),
  };
}

function requiredText(value: string | undefined, maxBytes: number): string {
  const validated = optionalText(value, maxBytes);
  if (validated === null) throw invalidInspection();
  return validated;
}

function optionalText(value: string | undefined, maxBytes: number): string | null {
  if (value === undefined) return null;
  if (
    value.length === 0 ||
    value !== value.normalize("NFC") ||
    Buffer.byteLength(value) > maxBytes ||
    hasUnsafeControl(value)
  ) {
    throw invalidInspection();
  }
  return value;
}

function hasUnsafeControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return (code >= 0 && code <= 8) || code === 11 || code === 12 ||
      (code >= 14 && code <= 31) || code === 127;
  });
}

function invalidInspection(): BwaRegistryError {
  return new BwaRegistryError(
    "IMAGE_INSPECTION_INVALID",
    "Image BWA metadata is incomplete or invalid.",
  );
}

function validateEnvironmentInput(
  ordinary: Record<string, string>,
  sensitive: Record<string, string>,
): void {
  const entries = [...Object.entries(ordinary), ...Object.entries(sensitive)];
  if (entries.length > 256) throw new Error("BWA environment is invalid.");
  const names = new Set<string>();
  let totalBytes = 0;
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ||
      name.startsWith("BIUNIVERS_") ||
      names.has(name) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Buffer.byteLength(value) > 64 * 1024
    ) {
      throw new Error("BWA environment is invalid.");
    }
    names.add(name);
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (totalBytes > 256 * 1024) throw new Error("BWA environment is invalid.");
}
