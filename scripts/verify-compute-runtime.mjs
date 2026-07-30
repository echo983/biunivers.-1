import { createConnection } from "node:net";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const [socketPath, tokenHex, fixturePath, runRoot] = process.argv.slice(2);
if (!socketPath || !tokenHex || !fixturePath || !runRoot) {
  throw new Error(
    "usage: verify-compute-runtime.mjs <socket> <token> <fixture> <run-root>",
  );
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const prepare = await exchange({ tokenHex, operation: "prepare", input: fixture });
assertOk(prepare, "prepare");
if (prepare.result.state !== "PREPARED") throw new Error("Run not PREPARED.");

const start = await exchange({
  tokenHex,
  operation: "start",
  runIdHex: fixture.runIdHex,
});
assertOk(start, "start");
if (start.result.state !== "RUNNING") throw new Error("Run not RUNNING.");

const diagnosticPath = join(
  runRoot,
  fixture.runIdHex,
  "merged",
  ".biunivers-runtime-diagnostic.json",
);
let diagnostic;
try {
  diagnostic = await waitForJson(diagnosticPath);
} catch (error) {
  const failedInspect = await exchange({
    tokenHex,
    operation: "inspect",
    runIdHex: fixture.runIdHex,
  });
  const logs = await containerLogs(fixture.runIdHex);
  throw new Error(
    `${error.message} Container state: ${JSON.stringify(failedInspect.result?.container ?? failedInspect)} Logs: ${logs}`,
  );
}
const inspect = await exchange({
  tokenHex,
  operation: "inspect",
  runIdHex: fixture.runIdHex,
});
assertOk(inspect, "inspect");
if (!inspect.result.container?.running) {
  throw new Error("Diagnostic container is not running.");
}
for (const [key, expected] of Object.entries({
  uid: 65532,
  gid: 65532,
  network: "none",
  capabilities: "none",
  workspaceWritable: true,
})) {
  if (diagnostic[key] !== expected) {
    throw new Error(`Diagnostic assertion failed: ${key}`);
  }
}

const freeze = await exchange({
  tokenHex,
  operation: "freeze",
  runIdHex: fixture.runIdHex,
});
assertOk(freeze, "freeze");
if (freeze.result.state !== "FROZEN") throw new Error("Run not FROZEN.");
const frozenInspect = await exchange({
  tokenHex,
  operation: "inspect",
  runIdHex: fixture.runIdHex,
});
assertOk(frozenInspect, "inspect-frozen");
if (!frozenInspect.result.container?.paused) {
  throw new Error("Frozen container is not paused.");
}
const thaw = await exchange({
  tokenHex,
  operation: "thaw",
  runIdHex: fixture.runIdHex,
});
assertOk(thaw, "thaw");
if (thaw.result.state !== "RUNNING") throw new Error("Run not thawed.");

const stop = await exchange({
  tokenHex,
  operation: "stop",
  runIdHex: fixture.runIdHex,
});
assertOk(stop, "stop");
if (stop.result.state !== "STOPPED") throw new Error("Run not STOPPED.");
const upperDiagnostic = JSON.parse(
  await readFile(
    join(
      runRoot,
      fixture.runIdHex,
      "upper",
      ".biunivers-runtime-diagnostic.json",
    ),
    "utf8",
  ),
);
const destroy = await exchange({
  tokenHex,
  operation: "destroy",
  runIdHex: fixture.runIdHex,
  preserveUpper: true,
});
assertOk(destroy, "destroy");
const destroyedInspect = await exchange({
  tokenHex,
  operation: "inspect",
  runIdHex: fixture.runIdHex,
});
assertOk(destroyedInspect, "inspect-destroyed");
if (destroyedInspect.result.manifest?.state !== "DESTROYED") {
  throw new Error("Run not DESTROYED.");
}
await readFile(
  join(
    runRoot,
    fixture.runIdHex,
    "upper",
    ".biunivers-runtime-diagnostic.json",
  ),
);
console.log(
  JSON.stringify({
    runIdHex: fixture.runIdHex,
    runtimeIdentity: start.result.runtimeIdentity,
    diagnostic: upperDiagnostic,
    finalState: destroyedInspect.result.manifest.state,
    upperPreserved: true,
  }),
);

async function exchange(requestValue) {
  const payload = Buffer.from(JSON.stringify(requestValue));
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => socket.end(frame));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.once("end", resolve);
    socket.once("error", reject);
  });
  const response = Buffer.concat(chunks);
  if (
    response.byteLength < 4 ||
    response.readUInt32BE(0) !== response.length - 4
  ) {
    throw new Error("Runtime response frame is invalid.");
  }
  return JSON.parse(response.subarray(4).toString("utf8"));
}

function assertOk(response, operation) {
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.error ?? "unknown"}`);
  }
}

async function waitForJson(path) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Diagnostic executor did not publish its result.");
}

async function containerLogs(runIdHex) {
  try {
    const result = await execFileAsync(
      "docker",
      ["logs", `biunivers-run-${runIdHex}`],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
    );
    return `${result.stdout}${result.stderr}`.trim() || "(empty)";
  } catch (error) {
    return error instanceof Error ? error.message : "unavailable";
  }
}
