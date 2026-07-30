import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { loadServerConfig } from "../dist/server/config.js";
import { loadCurrentEntryIndex } from "../dist/server/files/entryIndex.js";
import { startFileService } from "../dist/server/files/fileServiceRuntime.js";

const [operation, fixturePath] = process.argv.slice(2);
if (!["prepare", "verify", "fail"].includes(operation) || !fixturePath) {
  throw new Error(
    "usage: compute-runtime-fixture.mjs <prepare|verify|fail> <fixture-json>",
  );
}

const config = loadServerConfig();
if (!config.fileService) throw new Error("File Service is disabled.");
config.fileService.initialize = false;
const runtime = await startFileService(config.fileService);
if (
  runtime.status.mode !== "ready" ||
  !runtime.refStore ||
  !runtime.repository
) {
  const status = JSON.stringify(runtime.status);
  runtime.close();
  throw new Error(`File Service is not ready: ${status}`);
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
    if (operation === "verify") {
      if (run.state !== "COMMITTED" || !run.outputHeadFidHex) {
        throw new Error(`Run was not committed: ${run.state}`);
      }
      const workspace = runtime.refStore.getWorkspace(fixture.workspaceIdHex);
      const ref = runtime.refStore.getRef(workspace.refId);
      if (
        ref.headFidHex !== run.outputHeadFidHex ||
        ref.revision !== fixture.revision + 1
      ) {
        throw new Error("Committed Workspace Ref is inconsistent.");
      }
      const index = await loadCurrentEntryIndex(
        runtime.repository,
        runtime.refStore,
        workspace.refId,
      );
      const diagnostic = index
        .listChildren(index.rootEntryIdHex)
        .find((entry) => entry.name === ".biunivers-runtime-diagnostic.json");
      if (!diagnostic?.content || diagnostic.content.kind !== "chunk") {
        throw new Error("Committed diagnostic output is missing.");
      }
      const bytes = await runtime.repository.get(
        "chunks",
        diagnostic.content.fidHex,
      );
      const value = JSON.parse(Buffer.from(bytes).toString("utf8"));
      if (value.workspaceWritable !== true || value.network !== "none") {
        throw new Error("Committed diagnostic output is invalid.");
      }
      console.log(
        JSON.stringify({
          state: run.state,
          revision: ref.revision,
          outputHeadFidHex: run.outputHeadFidHex,
          diagnostic: value,
        }),
      );
    } else if (
      run.state === "PREPARING" ||
      run.state === "RUNNING" ||
      run.state === "STOPPED" ||
      run.state === "COMMITTING"
    ) {
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
