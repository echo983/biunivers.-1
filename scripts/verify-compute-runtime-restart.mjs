import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const [phase, socketPath, tokenHex, fixturePath, runRoot] =
  process.argv.slice(2);
if (
  !["start", "verify"].includes(phase) ||
  !socketPath ||
  !tokenHex ||
  !fixturePath ||
  !runRoot
) {
  throw new Error(
    "usage: verify-compute-runtime-restart.mjs <start|verify> <socket> <token> <fixture> <run-root>",
  );
}
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));

if (phase === "start") {
  assertOk(
    await exchange({ tokenHex, operation: "prepare", input: fixture }),
    "prepare",
  );
  const started = await exchange({
    tokenHex,
    operation: "start",
    runIdHex: fixture.runIdHex,
  });
  assertOk(started, "start");
  const diagnostic = await waitForJson(
    join(
      runRoot,
      fixture.runIdHex,
      "merged",
      ".biunivers-runtime-diagnostic.json",
    ),
  );
  console.log(
    JSON.stringify({
      runIdHex: fixture.runIdHex,
      runtimeIdentity: started.result.runtimeIdentity,
      diagnostic,
    }),
  );
} else {
  const inspected = await exchange({
    tokenHex,
    operation: "inspect",
    runIdHex: fixture.runIdHex,
  });
  assertOk(inspected, "inspect");
  if (
    inspected.result.manifest?.state !== "FAILED" ||
    inspected.result.manifest?.errorCode !== "INTERRUPTED_DAEMON_RECOVERY"
  ) {
    throw new Error(
      `Recovered local Run is invalid: ${JSON.stringify(inspected.result)}`,
    );
  }
  const diagnostic = JSON.parse(
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
  const containerName = `biunivers-run-${fixture.runIdHex}`;
  const containers = await execFileAsync(
    "docker",
    [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `name=^/${containerName}$`,
    ],
    { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  if (containers.stdout.trim()) {
    throw new Error("Interrupted Runtime container was not removed.");
  }
  for (const name of ["lower", "merged"]) {
    const path = join(runRoot, fixture.runIdHex, name);
    const mounted = await execFileAsync(
      "findmnt",
      ["--noheadings", "--mountpoint", path],
      { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
    ).then(
      () => true,
      (error) => {
        if (error && typeof error === "object" && error.code === 1) return false;
        throw error;
      },
    );
    if (mounted) throw new Error(`Interrupted mount remains active: ${name}`);
  }
  console.log(
    JSON.stringify({
      runIdHex: fixture.runIdHex,
      localState: inspected.result.manifest.state,
      localErrorCode: inspected.result.manifest.errorCode,
      containerRemoved: true,
      mountsReleased: true,
      upperPreserved: true,
      diagnostic,
    }),
  );
}

function assertOk(response, operation) {
  if (!response.ok) {
    throw new Error(`${operation} failed: ${response.error ?? "unknown"}`);
  }
}

async function exchange(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const request = Buffer.allocUnsafe(4 + payload.byteLength);
  request.writeUInt32BE(payload.byteLength, 0);
  payload.copy(request, 4);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", resolve);
    socket.on("error", reject);
  });
  const response = Buffer.concat(chunks);
  if (
    response.byteLength < 4 ||
    response.readUInt32BE(0) !== response.byteLength - 4
  ) {
    throw new Error("Runtime response frame is invalid.");
  }
  return JSON.parse(response.subarray(4).toString("utf8"));
}

async function waitForJson(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (attempt === 99) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Diagnostic executor did not publish its result.");
}
