import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { BwaLifecycleService } from "../dist/server/bwa/bwaLifecycleService.js";
import { BwaRegistryService } from "../dist/server/bwa/bwaRegistryService.js";
import { BwaSecretStore } from "../dist/server/bwa/bwaSecretStore.js";
import { ComputeRuntimeImageClient } from "../dist/server/bwa/computeRuntimeImageClient.js";
import { ComputeRuntimeLifecycleClient } from "../dist/server/bwa/computeRuntimeLifecycleClient.js";
import { loadServerConfig } from "../dist/server/config.js";
import { startFileService } from "../dist/server/files/fileServiceRuntime.js";

const execFileAsync = promisify(execFile);
const [socketPath, tokenHex, fixturePath, secretPath] = process.argv.slice(2);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const config = loadServerConfig();
config.fileService.initialize = false;
const fileRuntime = await startFileService(config.fileService);
if (fileRuntime.status.mode !== "ready" || !fileRuntime.refStore) {
  throw new Error("File Service is not ready.");
}

try {
  const runtime = new ComputeRuntimeLifecycleClient({
    socketPath,
    authenticationTokenHex: tokenHex,
  });
  const secrets = new BwaSecretStore(secretPath);
  await secrets.initialize();
  const registry = new BwaRegistryService({
    refStore: fileRuntime.refStore,
    secrets,
    images: new ComputeRuntimeImageClient({
      socketPath,
      authenticationTokenHex: tokenHex,
    }),
  });
  const lifecycle = new BwaLifecycleService({
    refStore: fileRuntime.refStore,
    environment: registry,
    runtime,
  });
  const failed = fileRuntime.refStore
    .listBwaRunBindings(fixture.instanceIdHex)
    .find(({ run }) => run.state === "FAILED");
  if (!failed) throw new Error("Interrupted BWA failure was not found.");
  await lifecycle.discardFailedUpper(fixture.instanceIdHex, failed.run.runIdHex);
  const running = await lifecycle.start(fixture.instanceIdHex);
  const state = await containerFetch(running.runIdHex, "/api/increment", "POST");
  if (state.count !== 3) throw new Error("Controlled-shutdown BWA did not write count=3.");
  console.log(JSON.stringify({ runIdHex: running.runIdHex, count: state.count }));
} finally {
  fileRuntime.close();
}

async function containerFetch(runIdHex, path, method) {
  const name = `biunivers-run-${runIdHex}`;
  const script = `fetch("http://127.0.0.1:8080${path}",{method:"${method}"}).then(async r=>{if(!r.ok)process.exit(2);console.log(await r.text())}).catch(()=>process.exit(3))`;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const result = await execFileAsync("docker", ["exec", name, "node", "-e", script], {
        encoding: "utf8",
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Controlled-shutdown BWA HTTP service did not become ready.");
}
