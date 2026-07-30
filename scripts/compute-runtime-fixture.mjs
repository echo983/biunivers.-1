import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { loadServerConfig } from "../dist/server/config.js";
import { startFileService } from "../dist/server/files/fileServiceRuntime.js";

const [operation, fixturePath, runtimeIdentity] = process.argv.slice(2);
if (!["prepare", "finish", "fail"].includes(operation) || !fixturePath) {
  throw new Error(
    "usage: compute-runtime-fixture.mjs <prepare|finish|fail> <fixture-json> [runtime-identity]",
  );
}

const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const runtime = await startFileService(config.fileService);
if (runtime.status.mode !== "ready" || !runtime.refStore) {
  runtime.close();
  throw new Error("File Service is not ready.");
}

try {
  if (operation === "prepare") {
    const workspace = runtime.refStore.listWorkspaces().at(-1);
    if (!workspace) throw new Error("No Workspace exists.");
    const ref = runtime.refStore.getRef(workspace.refId);
    const fixture = {
      runIdHex: randomBytes(16).toString("hex"),
      workspaceIdHex: workspace.workspaceIdHex,
      inputHeadFidHex: ref.headFidHex,
      revision: ref.revision,
      executorId: "system.diagnostic",
      capabilityHex: randomBytes(32).toString("hex"),
    };
    runtime.refStore.createWorkspaceRun({
      runIdHex: fixture.runIdHex,
      workspaceIdHex: fixture.workspaceIdHex,
      executorId: fixture.executorId,
      inputHeadFidHex: fixture.inputHeadFidHex,
      createdAtMs: Date.now(),
    });
    await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify(fixture));
  } else {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    const run = runtime.refStore.getWorkspaceRun(fixture.runIdHex);
    if (operation === "finish") {
      if (!runtimeIdentity) throw new Error("Runtime identity is required.");
      runtime.refStore.transitionWorkspaceRun({
        runIdHex: fixture.runIdHex,
        expectedState: run.state,
        newState: "RUNNING",
        runtimeIdentity,
        timestampMs: Date.now(),
      });
      runtime.refStore.transitionWorkspaceRun({
        runIdHex: fixture.runIdHex,
        expectedState: "RUNNING",
        newState: "STOPPED",
        timestampMs: Date.now() + 1,
      });
    } else if (run.state === "PREPARING" || run.state === "RUNNING") {
      runtime.refStore.transitionWorkspaceRun({
        runIdHex: fixture.runIdHex,
        expectedState: run.state,
        newState: "FAILED",
        errorCode: "DIAGNOSTIC_TEST_FAILED",
        timestampMs: Date.now(),
      });
    }
  }
} finally {
  runtime.close();
}
