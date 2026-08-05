import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const INSTANCE_ID_PATTERN = /^[0-9a-f]{32}$/;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

interface SecretDocument {
  schemaVersion: 2;
  values: Record<string, Record<string, string>>;
  applicationValues: Record<string, Record<string, string>>;
}

export class BwaSecretStore {
  readonly #path: string;

  constructor(path: string) {
    if (!path.startsWith("/")) throw new Error("BWA secret path must be absolute.");
    this.#path = path;
  }

  async initialize(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    await chmod(dirname(this.#path), 0o700);
    try {
      await this.#read();
      await chmod(this.#path, 0o600);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      await this.#write({ schemaVersion: 2, values: {}, applicationValues: {} });
    }
  }

  async replace(instanceIdHex: string, values: Record<string, string>): Promise<void> {
    validateInstanceId(instanceIdHex);
    validateValues(values);
    const document = await this.#read();
    if (Object.keys(values).length === 0) {
      delete document.values[instanceIdHex];
    } else {
      document.values[instanceIdHex] = { ...values };
    }
    await this.#write(document);
  }

  async read(instanceIdHex: string, names: readonly string[]): Promise<Record<string, string>> {
    validateInstanceId(instanceIdHex);
    for (const name of names) validateName(name);
    const stored = (await this.#read()).values[instanceIdHex] ?? {};
    const output: Record<string, string> = {};
    for (const name of names) {
      if (!Object.hasOwn(stored, name)) {
        throw new Error(`Sensitive variable ${name} has no stored value.`);
      }
      output[name] = stored[name]!;
    }
    return output;
  }

  async replaceApplication(applicationId: string, values: Record<string, string>): Promise<void> {
    validateApplicationId(applicationId);
    validateValues(values);
    const document = await this.#read();
    if (Object.keys(values).length === 0) delete document.applicationValues[applicationId];
    else document.applicationValues[applicationId] = { ...values };
    await this.#write(document);
  }

  async readApplication(applicationId: string, names: readonly string[]): Promise<Record<string, string>> {
    validateApplicationId(applicationId);
    for (const name of names) validateName(name);
    const stored = (await this.#read()).applicationValues[applicationId] ?? {};
    const output: Record<string, string> = {};
    for (const name of names) {
      if (!Object.hasOwn(stored, name)) throw new Error(`Sensitive variable ${name} has no stored value.`);
      output[name] = stored[name]!;
    }
    return output;
  }

  async deleteApplication(applicationId: string): Promise<void> {
    validateApplicationId(applicationId);
    const document = await this.#read();
    if (delete document.applicationValues[applicationId]) await this.#write(document);
  }

  async deleteInstance(instanceIdHex: string): Promise<void> {
    validateInstanceId(instanceIdHex);
    const document = await this.#read();
    if (delete document.values[instanceIdHex]) await this.#write(document);
  }

  async prune(reachableInstanceIdsHex: ReadonlySet<string>): Promise<number> {
    for (const id of reachableInstanceIdsHex) validateInstanceId(id);
    const document = await this.#read();
    let removed = 0;
    for (const id of Object.keys(document.values)) {
      if (!reachableInstanceIdsHex.has(id)) {
        delete document.values[id];
        removed += 1;
      }
    }
    if (removed > 0) await this.#write(document);
    return removed;
  }

  async #read(): Promise<SecretDocument> {
    const raw = await readFile(this.#path, "utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new Error("BWA secret store is corrupt.", { cause: error });
    }
    return validateDocument(value);
  }

  async #write(document: SecretDocument): Promise<void> {
    const directory = dirname(this.#path);
    const temporary = join(directory, `.${randomUUID()}.bwa-secrets`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(document)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#path);
      await chmod(this.#path, 0o600);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function validateDocument(value: unknown): SecretDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("BWA secret store is corrupt.");
  }
  const document = value as Record<string, unknown>;
  if (
    ![1, 2].includes(document.schemaVersion as number) ||
    !document.values ||
    typeof document.values !== "object" ||
    Array.isArray(document.values) ||
    Object.keys(document).some((key) => !["schemaVersion", "values", "applicationValues"].includes(key))
  ) {
    throw new Error("BWA secret store is corrupt.");
  }
  const values = document.values as Record<string, unknown>;
  const validated: SecretDocument = { schemaVersion: 2, values: {}, applicationValues: {} };
  for (const [instanceId, variables] of Object.entries(values)) {
    validateInstanceId(instanceId);
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      throw new Error("BWA secret store is corrupt.");
    }
    validateValues(variables as Record<string, unknown>);
    validated.values[instanceId] = { ...(variables as Record<string, string>) };
  }
  const applicationValues = document.applicationValues ?? {};
  if (!applicationValues || typeof applicationValues !== "object" || Array.isArray(applicationValues)) {
    throw new Error("BWA secret store is corrupt.");
  }
  for (const [applicationId, variables] of Object.entries(applicationValues as Record<string, unknown>)) {
    validateApplicationId(applicationId);
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error("BWA secret store is corrupt.");
    validateValues(variables as Record<string, unknown>);
    validated.applicationValues[applicationId] = { ...(variables as Record<string, string>) };
  }
  return validated;
}

function validateValues(values: Record<string, unknown>): void {
  if (Object.keys(values).length > 256) throw new Error("Too many BWA secrets.");
  let totalBytes = 0;
  for (const [name, value] of Object.entries(values)) {
    validateName(name);
    if (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 64 * 1024) {
      throw new Error("BWA secret value is invalid.");
    }
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
  }
  if (totalBytes > 256 * 1024) throw new Error("BWA secrets exceed their size limit.");
}

function validateName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.startsWith("BIUNIVERS_")) {
    throw new Error("BWA secret name is invalid.");
  }
}

function validateInstanceId(value: string): void {
  if (!INSTANCE_ID_PATTERN.test(value) || value === "0".repeat(32)) {
    throw new Error("BWA Instance ID is invalid.");
  }
}

function validateApplicationId(value: string): void {
  if (!/^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value)) {
    throw new Error("BWA Application ID is invalid.");
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
