import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputeRuntimeImageClient } from "../dist/server/bwa/computeRuntimeImageClient.js";
import { ComputeRuntimeServer } from "../dist/server/computeRuntime/computeRuntimeServer.js";
import { DockerImageAdapter } from "../dist/server/computeRuntime/dockerImageAdapter.js";

const reference =
  process.argv[2] ?? "ghcr.io/echo983/biunivers-bwa-diagnostic:latest";
const root = await mkdtemp(join(tmpdir(), "biunivers-bwa-image-api-"));
const socketPath = join(root, "runtime.sock");
const tokenHex = randomBytes(32).toString("hex");
const images = new DockerImageAdapter();
const unavailable = async () => {
  throw new Error("Run operation is unavailable during Image API verification.");
};
const server = new ComputeRuntimeServer({
  socketPath,
  authenticationTokenHex: tokenHex,
  runtime: {
    pullAndInspect: (value) => images.pullAndInspect(value),
    inspectInstalled: (value) => images.inspectInstalled(value),
    prepare: unavailable,
    start: unavailable,
    inspect: unavailable,
    freeze: unavailable,
    thaw: unavailable,
    stop: unavailable,
    commit: unavailable,
    destroy: unavailable,
  },
});
await server.listen();
let pulled;
let installed;
try {
  const client = new ComputeRuntimeImageClient({
    socketPath,
    authenticationTokenHex: tokenHex,
  });
  pulled = await client.pullAndInspect(reference);
  assertInspection(pulled);
  installed = await client.inspectInstalled(pulled.imageReference);
  assertInspection(installed);
} finally {
  await server.close();
  await rm(root, { recursive: true, force: true });
}

if (
  installed.canonicalRepository !== pulled.canonicalRepository ||
  installed.digest !== pulled.digest ||
  installed.imageReference !== pulled.imageReference
) {
  throw new Error("Installed image inspection changed its fixed identity.");
}

console.log(
  JSON.stringify(
    {
      canonicalRepository: installed.canonicalRepository,
      digest: installed.digest,
      imageReference: installed.imageReference,
      protocolVersion:
        installed.labels["io.biunivers.workspace-application.protocol"],
      description: installed.labels["org.opencontainers.image.description"],
      source: installed.labels["org.opencontainers.image.source"],
      platform: `${installed.os}/${installed.architecture}`,
    },
    null,
    2,
  ),
);

function assertInspection(value) {
  if (
    value.labels["io.biunivers.workspace-application.protocol"] !== "1" ||
    !value.labels["org.opencontainers.image.description"] ||
    value.labels["org.opencontainers.image.source"] !==
      "https://github.com/echo983/biunivers-bwa-diagnostic"
  ) {
    throw new Error("Published image does not carry the required BWA metadata.");
  }
}
