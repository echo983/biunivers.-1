const EXECUTOR_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const IMAGE_PATTERN =
  /^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[0-9a-f]{64}$/;

export interface ExecutorDefinition {
  executorId: string;
  image: string;
  entrypoint: string;
  arguments: readonly string[];
  uid: number;
  gid: number;
  cpuLimit: number;
  memoryBytes: number;
  pidsLimit: number;
  timeoutMs: number;
  upperBytesLimit: number;
  upperInodesLimit: number;
  outputBytesLimit: number;
}

export class ExecutorRegistryError extends Error {
  constructor(
    public readonly code:
      | "EXECUTOR_INVALID"
      | "EXECUTOR_DUPLICATE"
      | "EXECUTOR_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ExecutorRegistryError";
  }
}

export class ExecutorRegistry {
  readonly #executors = new Map<string, ExecutorDefinition>();

  constructor(definitions: readonly ExecutorDefinition[]) {
    if (definitions.length === 0) {
      throw invalid("At least one fixed Executor is required.");
    }
    for (const definition of definitions) {
      validateDefinition(definition);
      if (this.#executors.has(definition.executorId)) {
        throw new ExecutorRegistryError(
          "EXECUTOR_DUPLICATE",
          "Executor ID is duplicated.",
        );
      }
      this.#executors.set(
        definition.executorId,
        Object.freeze({
          ...definition,
          arguments: Object.freeze([...definition.arguments]),
        }),
      );
    }
  }

  get(executorId: string): ExecutorDefinition {
    const definition = this.#executors.get(executorId);
    if (!definition) {
      throw new ExecutorRegistryError(
        "EXECUTOR_NOT_FOUND",
        "Executor is not registered.",
      );
    }
    return definition;
  }

  list(): ExecutorDefinition[] {
    return [...this.#executors.values()].sort((left, right) =>
      left.executorId < right.executorId
        ? -1
        : left.executorId > right.executorId
          ? 1
          : 0,
    );
  }
}

function validateDefinition(definition: ExecutorDefinition): void {
  if (
    !EXECUTOR_ID_PATTERN.test(definition.executorId) ||
    !IMAGE_PATTERN.test(definition.image) ||
    !isSafeArgument(definition.entrypoint) ||
    !definition.entrypoint.startsWith("/") ||
    definition.arguments.some((argument) => !isSafeArgument(argument)) ||
    !isPositiveInteger(definition.uid) ||
    !isPositiveInteger(definition.gid) ||
    !Number.isFinite(definition.cpuLimit) ||
    definition.cpuLimit <= 0 ||
    definition.cpuLimit > 64 ||
    !isPositiveInteger(definition.memoryBytes) ||
    !isPositiveInteger(definition.pidsLimit) ||
    !isPositiveInteger(definition.timeoutMs) ||
    !isPositiveInteger(definition.upperBytesLimit) ||
    !isPositiveInteger(definition.upperInodesLimit) ||
    !isPositiveInteger(definition.outputBytesLimit)
  ) {
    throw invalid("Executor definition is invalid.");
  }
}

function isSafeArgument(value: string): boolean {
  return (
    Buffer.byteLength(value) >= 1 &&
    Buffer.byteLength(value) <= 4096 &&
    !value.includes("\0")
  );
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function invalid(message: string): ExecutorRegistryError {
  return new ExecutorRegistryError("EXECUTOR_INVALID", message);
}
