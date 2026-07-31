import {
  DockerOciError,
  SystemCommandExecutor,
  type CommandExecutor,
} from "./dockerOciAdapter.js";

const REPOSITORY_PATTERN =
  /^ghcr\.io\/[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._/-][a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_INSPECT_BYTES = 1024 * 1024;

export interface BwaImageInspection {
  canonicalRepository: string;
  digest: string;
  imageReference: string;
  labels: Record<string, string>;
  entrypoint: string[];
  cmd: string[];
  architecture: string;
  os: string;
}

export class DockerImageAdapter {
  readonly #executor: CommandExecutor;

  constructor(executor: CommandExecutor = new SystemCommandExecutor()) {
    this.#executor = executor;
  }

  async pullAndInspect(reference: string): Promise<BwaImageInspection> {
    const parsed = parseDiscoveryReference(reference);
    await this.#execute(["pull", parsed.discoveryReference], 10 * 60_000, 64 * 1024);
    return await this.#inspect(parsed.discoveryReference, parsed.repository);
  }

  async inspectInstalled(imageReference: string): Promise<BwaImageInspection> {
    const parsed = parseInstalledReference(imageReference);
    return await this.#inspect(imageReference, parsed.repository, parsed.digest);
  }

  async #inspect(
    imageReference: string,
    repository: string,
    expectedDigest?: string,
  ): Promise<BwaImageInspection> {
    const result = await this.#execute(
      ["image", "inspect", imageReference],
      30_000,
      MAX_INSPECT_BYTES,
    );
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch (error) {
      throw invalidInspection("Docker image inspect returned invalid JSON.", error);
    }
    if (!Array.isArray(value) || value.length !== 1) {
      throw invalidInspection("Docker image inspect returned an unexpected result.");
    }
    const image = record(value[0]);
    const repoDigests = image.RepoDigests;
    const config = record(image.Config);
    if (
      !Array.isArray(repoDigests) ||
      typeof image.Architecture !== "string" ||
      typeof image.Os !== "string"
    ) {
      throw invalidInspection("Docker image identity is incomplete.");
    }
    const matching = new Set(
      repoDigests
        .filter((item): item is string => typeof item === "string")
        .map(parseRepoDigest)
        .filter((item) => item.repository === repository)
        .map((item) => item.digest),
    );
    if (matching.size !== 1) {
      throw invalidInspection("Image has no unique matching local RepoDigest.");
    }
    const digest = [...matching][0]!;
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      throw invalidInspection("Installed image does not match its fixed digest.");
    }
    const labels = validateLabels(config.Labels);
    const entrypoint = validateCommand(config.Entrypoint, "Entrypoint");
    const cmd = validateCommand(config.Cmd, "Cmd");
    if (
      entrypoint.length + cmd.length > 128 ||
      Buffer.byteLength(JSON.stringify([entrypoint, cmd])) > 16 * 1024
    ) {
      throw invalidInspection("Image command metadata exceeds its limit.");
    }
    return {
      canonicalRepository: repository,
      digest,
      imageReference: `${repository}@${digest}`,
      labels,
      entrypoint,
      cmd,
      architecture: image.Architecture,
      os: image.Os,
    };
  }

  async #execute(
    arguments_: readonly string[],
    timeoutMs: number,
    maxOutputBytes: number,
  ) {
    try {
      return await this.#executor.execute("docker", arguments_, {
        timeoutMs,
        maxOutputBytes,
      });
    } catch (error) {
      throw new DockerOciError(
        "OCI_COMMAND_FAILED",
        `Docker image ${arguments_[0] ?? "operation"} failed.`,
        { cause: error },
      );
    }
  }
}

export function parseDiscoveryReference(reference: string): {
  repository: string;
  discoveryReference: string;
} {
  if (reference !== reference.trim() || reference.includes("@")) {
    throw new Error("BWA image reference is invalid.");
  }
  const separator = reference.lastIndexOf(":");
  const hasTag = separator > "ghcr.io/".length;
  const repository = (hasTag ? reference.slice(0, separator) : reference).toLowerCase();
  const tag = hasTag ? reference.slice(separator + 1) : "latest";
  if (!REPOSITORY_PATTERN.test(repository) || !TAG_PATTERN.test(tag)) {
    throw new Error("BWA image reference is invalid.");
  }
  return { repository, discoveryReference: `${repository}:${tag}` };
}

export function parseInstalledReference(imageReference: string): {
  repository: string;
  digest: string;
} {
  const at = imageReference.indexOf("@");
  const repository = imageReference.slice(0, at);
  const digest = imageReference.slice(at + 1);
  if (
    at <= 0 ||
    imageReference.indexOf("@", at + 1) !== -1 ||
    !REPOSITORY_PATTERN.test(repository) ||
    !DIGEST_PATTERN.test(digest)
  ) {
    throw new Error("Installed BWA image reference is invalid.");
  }
  return { repository, digest };
}

function parseRepoDigest(value: string): { repository: string; digest: string } {
  const parsed = parseInstalledReference(value);
  return { repository: parsed.repository.toLowerCase(), digest: parsed.digest };
}

function validateLabels(value: unknown): Record<string, string> {
  if (value === null || value === undefined) return {};
  const labels = record(value);
  const output: Record<string, string> = {};
  for (const [key, label] of Object.entries(labels)) {
    if (typeof label !== "string") {
      throw invalidInspection("Image labels are invalid.");
    }
    output[key] = label;
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 32 * 1024) {
    throw invalidInspection("Image labels exceed their size limit.");
  }
  return output;
}

function validateCommand(value: unknown, label: string): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw invalidInspection(`Image ${label} is invalid.`);
  }
  return [...value] as string[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInspection("Docker image inspect returned an invalid object.");
  }
  return value as Record<string, unknown>;
}

function invalidInspection(message: string, cause?: unknown): DockerOciError {
  return new DockerOciError("OCI_OUTPUT_INVALID", message, { cause });
}
