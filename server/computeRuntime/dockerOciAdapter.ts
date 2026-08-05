import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { DockerOciPlan } from "./dockerOciPlan.js";

const execFileAsync = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export interface CommandExecutor {
  execute(
    executable: string,
    arguments_: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CommandResult>;
}

export interface OciContainerState {
  status: string;
  running: boolean;
  paused: boolean;
  restarting: boolean;
  oomKilled: boolean;
  dead: boolean;
  pid: number;
  exitCode: number;
  startedAt: string;
  finishedAt: string;
}

export class DockerOciError extends Error {
  constructor(
    public readonly code:
      | "OCI_COMMAND_FAILED"
      | "OCI_OUTPUT_INVALID"
      | "OCI_STATE_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DockerOciError";
  }
}

export class DockerOciAdapter {
  readonly #executor: CommandExecutor;

  constructor(executor: CommandExecutor = new SystemCommandExecutor()) {
    this.#executor = executor;
  }

  async create(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<string> {
    const result = await this.#run(plan, plan.createArguments, limits);
    const identity = result.stdout.trim();
    if (!/^[0-9a-f]{12,64}$/.test(identity)) {
      throw new DockerOciError(
        "OCI_OUTPUT_INVALID",
        "Docker create returned an invalid container identity.",
      );
    }
    return identity;
  }

  async start(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<void> {
    await this.#run(plan, plan.startArguments, limits);
  }

  async freeze(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<void> {
    await this.#run(plan, plan.freezeArguments, limits);
  }

  async thaw(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<void> {
    await this.#run(plan, plan.thawArguments, limits);
  }

  async inspect(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<OciContainerState> {
    const result = await this.#run(plan, plan.inspectArguments, limits);
    let value: unknown;
    try {
      value = JSON.parse(result.stdout);
    } catch (error) {
      throw new DockerOciError(
        "OCI_OUTPUT_INVALID",
        "Docker inspect returned invalid JSON.",
        { cause: error },
      );
    }
    return validateState(value);
  }

  async logs(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<string> {
    const result = await this.#run(plan, plan.logsArguments, limits);
    return `${result.stdout}${result.stderr}`.slice(-16_384);
  }

  async stop(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<void> {
    await this.#run(plan, plan.stopArguments, limits);
  }

  async remove(
    plan: DockerOciPlan,
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<void> {
    await this.#run(plan, plan.removeArguments, limits);
  }

  async #run(
    plan: DockerOciPlan,
    arguments_: readonly string[],
    limits: { timeoutMs: number; outputBytesLimit: number },
  ): Promise<CommandResult> {
    try {
      return await this.#executor.execute(
        plan.executable,
        arguments_,
        {
          timeoutMs: limits.timeoutMs,
          maxOutputBytes: limits.outputBytesLimit,
        },
      );
    } catch (error) {
      throw new DockerOciError(
        "OCI_COMMAND_FAILED",
        `Docker command ${arguments_[0] ?? "unknown"} failed.`,
        { cause: error },
      );
    }
  }
}

export class SystemCommandExecutor implements CommandExecutor {
  async execute(
    executable: string,
    arguments_: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CommandResult> {
    const result = await execFileAsync(executable, [...arguments_], {
      timeout: options.timeoutMs,
      maxBuffer: options.maxOutputBytes,
      encoding: "utf8",
      windowsHide: true,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  }
}

function validateState(value: unknown): OciContainerState {
  if (!value || typeof value !== "object") {
    throw stateInvalid();
  }
  const state = value as Record<string, unknown>;
  if (
    typeof state.Status !== "string" ||
    typeof state.Running !== "boolean" ||
    typeof state.Paused !== "boolean" ||
    typeof state.Restarting !== "boolean" ||
    typeof state.OOMKilled !== "boolean" ||
    typeof state.Dead !== "boolean" ||
    !Number.isSafeInteger(state.Pid) ||
    (state.Pid as number) < 0 ||
    !Number.isSafeInteger(state.ExitCode) ||
    typeof state.StartedAt !== "string" ||
    typeof state.FinishedAt !== "string"
  ) {
    throw stateInvalid();
  }
  return {
    status: state.Status,
    running: state.Running,
    paused: state.Paused,
    restarting: state.Restarting,
    oomKilled: state.OOMKilled,
    dead: state.Dead,
    pid: state.Pid as number,
    exitCode: state.ExitCode as number,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt,
  };
}

function stateInvalid(): DockerOciError {
  return new DockerOciError(
    "OCI_STATE_INVALID",
    "Docker container state is invalid.",
  );
}
