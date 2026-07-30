import { describe, expect, it } from "vitest";
import {
  DockerOciAdapter,
  type CommandExecutor,
  type CommandResult,
} from "./dockerOciAdapter.js";
import type { DockerOciPlan } from "./dockerOciPlan.js";

const plan: DockerOciPlan = {
  executable: "docker",
  containerName: "biunivers-run-test",
  createArguments: ["create", "--name", "biunivers-run-test", "image@sha256:x"],
  startArguments: ["start", "biunivers-run-test"],
  stopArguments: ["stop", "--time", "10", "biunivers-run-test"],
  inspectArguments: ["inspect", "--format", "{{json .State}}", "biunivers-run-test"],
  removeArguments: ["rm", "--force", "biunivers-run-test"],
};
const limits = { timeoutMs: 1000, outputBytesLimit: 4096 };

class FakeExecutor implements CommandExecutor {
  readonly calls: Array<{
    executable: string;
    arguments_: readonly string[];
    options: { timeoutMs: number; maxOutputBytes: number };
  }> = [];
  readonly results: CommandResult[] = [];

  async execute(
    executable: string,
    arguments_: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number },
  ): Promise<CommandResult> {
    this.calls.push({ executable, arguments_, options });
    const result = this.results.shift();
    if (!result) throw new Error("missing fake result");
    return result;
  }
}

describe("DockerOciAdapter", () => {
  it("runs only the prebuilt plan and validates container identity and state", async () => {
    const executor = new FakeExecutor();
    executor.results.push(
      { stdout: `${"a".repeat(64)}\n`, stderr: "" },
      { stdout: "", stderr: "" },
      {
        stdout: JSON.stringify({
          Status: "running",
          Running: true,
          Paused: false,
          Restarting: false,
          OOMKilled: false,
          Dead: false,
          Pid: 123,
          ExitCode: 0,
          StartedAt: "2026-07-30T00:00:00Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        }),
        stderr: "",
      },
      { stdout: "", stderr: "" },
      { stdout: "", stderr: "" },
    );
    const adapter = new DockerOciAdapter(executor);
    expect(await adapter.create(plan, limits)).toBe("a".repeat(64));
    await adapter.start(plan, limits);
    expect(await adapter.inspect(plan, limits)).toMatchObject({
      status: "running",
      running: true,
      pid: 123,
    });
    await adapter.stop(plan, limits);
    await adapter.remove(plan, limits);
    expect(executor.calls.map((call) => call.arguments_[0])).toEqual([
      "create",
      "start",
      "inspect",
      "stop",
      "rm",
    ]);
    expect(executor.calls.every((call) => call.executable === "docker")).toBe(
      true,
    );
    expect(executor.calls.every((call) => call.options.maxOutputBytes === 4096)).toBe(
      true,
    );
  });

  it("fails closed on malformed Docker output", async () => {
    const invalidIdentity = new FakeExecutor();
    invalidIdentity.results.push({ stdout: "container-name\n", stderr: "" });
    await expect(
      new DockerOciAdapter(invalidIdentity).create(plan, limits),
    ).rejects.toMatchObject({ code: "OCI_OUTPUT_INVALID" });

    const invalidState = new FakeExecutor();
    invalidState.results.push({ stdout: '{"Running":true}', stderr: "" });
    await expect(
      new DockerOciAdapter(invalidState).inspect(plan, limits),
    ).rejects.toMatchObject({ code: "OCI_STATE_INVALID" });
  });
});
