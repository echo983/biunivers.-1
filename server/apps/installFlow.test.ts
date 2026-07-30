// @vitest-environment node

import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  PreparedRepository,
  RepositorySource,
} from "../github/githubSource.js";
import { GitHubSourceError } from "../github/githubSource.js";
import { createAppServer } from "../http/appServer.js";
import { createDesktopServer } from "../http/desktopServer.js";
import { ManifestValidator } from "../manifests/manifestValidator.js";
import type { ServerConfig } from "../config.js";
import { AppService } from "./appService.js";
import { appSpecificOrigin } from "./appOrigin.js";
import { AppStore } from "./appStore.js";
import { InspectionService } from "./inspectionService.js";
import { OperationLock } from "./operationLock.js";
import { OpenResourceValidator } from "../openResource/openResourceValidator.js";
import { projectInstalledApp } from "./projection.js";

const templateDir = resolve(
  "docs",
  "developer-kit",
  "v1",
  "template",
  "minimal-app",
);
const protocolPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "BIUNIVERS_APP_PROTOCOL_V1.md",
);
const schemaPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "biunivers.app.schema.json",
);
const openResourceProtocolPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md",
);
const openResourceSchemaPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "biunivers.open-resource.schema.json",
);
const openResourceV11ProtocolPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1_1.md",
);
const openResourceV11SchemaPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "biunivers.open-resource-v1.1.schema.json",
);
const resourceSessionProtocolPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md",
);

function fetchApp(
  origin: string,
  appId: string,
  path: string,
): Promise<Response> {
  const url = new URL(path, origin);
  return new Promise((resolveRequest, rejectRequest) => {
    const outgoing = request(
      url,
      {
        headers: {
          host: new URL(appSpecificOrigin("http://localhost:8081", appId)).host,
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolveRequest(
            new Response(Buffer.concat(chunks), {
              status: incoming.statusCode,
              headers: incoming.headers as Record<string, string>,
            }),
          );
        });
      },
    );
    outgoing.on("error", rejectRequest);
    outgoing.end();
  });
}
const commitSha = "0123456789abcdef0123456789abcdef01234567";

let validator: ManifestValidator;
let openResourceValidator: OpenResourceValidator;
let resourceSessionProtocolBytes: Buffer;
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

class FixtureSource implements RepositorySource {
  commitSha = commitSha;
  version = "1.0.0";

  constructor(private readonly mutate?: (rootDir: string) => Promise<void>) {}

  async prepare(
    _repositoryInput: string,
    requestedRef: string,
    stagingDir: string,
  ): Promise<PreparedRepository> {
    const rootDir = join(stagingDir, "repository");
    await cp(templateDir, rootDir, { recursive: true });
    if (this.version !== "1.0.0") {
      const manifestPath = join(rootDir, "biunivers.app.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        version: string;
      };
      manifest.version = this.version;
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }
    await this.mutate?.(rootDir);
    return {
      repository: "https://github.com/example/hello",
      owner: "example",
      name: "hello",
      requestedRef,
      commitSha: this.commitSha,
      rootDir,
    };
  }
}

async function createServices(source: RepositorySource = new FixtureSource()) {
  const dataDir = await mkdtemp(join(tmpdir(), "biunivers-install-"));
  temporaryDirectories.push(dataDir);
  const appStore = new AppStore(dataDir);
  await appStore.initialize();
  const inspections = new InspectionService({
    source,
    validator,
    openResourceValidator,
    resourceSessionProtocolBytes,
    appStore,
    dataDir,
    maxAppBytes: 10 * 1024 * 1024,
    maxAppFiles: 100,
    reservedAppIds: new Set([
      "system.settings",
      "system.about",
      "system.files",
    ]),
  });
  const appService = new AppService({
    appStore,
    inspections,
    validator,
    operationLock: new OperationLock(),
    dataDir,
  });
  return { dataDir, appStore, inspections, appService };
}

async function listen(server: Server) {
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not bind");
  }
  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  validator = await ManifestValidator.create(schemaPath, protocolPath);
  openResourceValidator = await OpenResourceValidator.createRegistry([
    {
      protocol: "biunivers.open-resource/1",
      schemaPath: openResourceSchemaPath,
      protocolPath: openResourceProtocolPath,
      protocolFileName: "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md",
    },
    {
      protocol: "biunivers.open-resource/1.1",
      schemaPath: openResourceV11SchemaPath,
      protocolPath: openResourceV11ProtocolPath,
      protocolFileName: "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1_1.md",
    },
  ]);
  resourceSessionProtocolBytes = await readFile(resourceSessionProtocolPath);
});

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          ),
      ),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("inspect and install flow", () => {
  it("maps source input failures to a structured application error", async () => {
    const services = await createServices({
      async prepare() {
        throw new GitHubSourceError(
          "GITHUB_REF_NOT_FOUND",
          "无法解析 Git ref：GitHub HTTP 404",
        );
      },
    });

    await expect(
      services.inspections.create(
        "https://github.com/example/hello",
        "missing",
      ),
    ).rejects.toMatchObject({
      code: "GITHUB_REF_NOT_FOUND",
      status: 400,
      message: "无法解析 Git ref：GitHub HTTP 404",
    });
  });

  it("installs the template last and serves its entry and public config", async () => {
    const services = await createServices();
    const inspection = await services.inspections.create(
      "https://github.com/example/hello",
      "v1.0.0",
    );
    expect(inspection.operation).toBe("install");

    const installed = await services.appService.install(
      inspection.inspectionId,
      { greeting: "来自安装流程" },
    );
    expect(installed.appId).toBe("io.github.example.hello");
    await expect(services.appStore.read()).resolves.toMatchObject({
      apps: [{ appId: "io.github.example.hello", status: "active" }],
    });

    const origin = await listen(
      createAppServer({
        appStore: services.appStore,
        dataDir: services.dataDir,
        appOrigin: "http://localhost:8081",
      }).listen(0, "127.0.0.1"),
    );
    const base = `/apps/${commitSha}`;
    expect((await fetch(`${origin}${base}/index.html`)).status).toBe(404);
    expect(
      (await fetchApp(origin, "io.github.example.other", `${base}/index.html`))
        .status,
    ).toBe(404);
    expect(
      (
        await fetchApp(
          origin,
          installed.appId,
          `${base}/biunivers.open-resource.json`,
        )
      ).status,
    ).toBe(404);
    const appResponse = await fetchApp(
      origin,
      installed.appId,
      `${base}/index.html`,
    );
    expect(appResponse.status).toBe(200);
    expect(appResponse.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    await expect(
      fetchApp(origin, installed.appId, `${base}/.biunivers/config.json`).then(
        (response) => response.json(),
      ),
    ).resolves.toEqual({ greeting: "来自安装流程" });
    expect(
      (await fetchApp(origin, installed.appId, `${base}/biunivers.app.json`))
        .status,
    ).toBe(404);
    expect(
      (
        await fetchApp(
          origin,
          installed.appId,
          `${base}/BIUNIVERS_APP_PROTOCOL_V1.md`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await fetchApp(
          origin,
          installed.appId,
          `${base}/BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md`,
        )
      ).status,
    ).toBe(404);
  });

  it("rejects changed protocol bytes before an app is registered", async () => {
    const services = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "BIUNIVERS_APP_PROTOCOL_V1.md"),
          "modified",
        );
      }),
    );

    await expect(
      services.inspections.create("https://github.com/example/hello", "v1.0.0"),
    ).rejects.toMatchObject({ code: "PROTOCOL_MISMATCH" });
    await expect(services.appStore.read()).resolves.toMatchObject({
      apps: [],
    });
  });

  it("validates, installs and projects an optional resource handler", async () => {
    const services = await createServices(
      new FixtureSource(async (rootDir) => {
        await cp(
          openResourceProtocolPath,
          join(rootDir, "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md"),
        );
        await writeFile(
          join(rootDir, "biunivers.open-resource.json"),
          JSON.stringify({
            protocol: "biunivers.open-resource/1",
            handlers: [
              {
                id: "text-editor",
                actions: ["open", "edit"],
                extensions: [".txt"],
                mediaTypes: ["text/plain"],
                access: "read-write",
              },
            ],
          }),
        );
      }),
    );

    const inspection = await services.inspections.create(
      "https://github.com/example/hello",
      "v1.0.0",
    );
    expect(inspection.openResource).toMatchObject({
      protocol: "biunivers.open-resource/1",
      handlers: [{ id: "text-editor", extensions: [".txt"] }],
    });

    const installed = await services.appService.install(
      inspection.inspectionId,
      { greeting: "handler install" },
    );
    expect(installed.openResource).toEqual(inspection.openResource);
    expect(
      projectInstalledApp(installed, "http://localhost:8081"),
    ).toMatchObject({
      resourceHandlers: [
        {
          id: "text-editor",
          actions: ["open", "edit"],
          extensions: [".txt"],
          access: "read-write",
        },
      ],
    });
  });

  it("rejects incomplete or changed Open Resource extension files", async () => {
    const incomplete = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "biunivers.open-resource.json"),
          JSON.stringify({
            protocol: "biunivers.open-resource/1",
            handlers: [
              {
                id: "text",
                actions: ["open"],
                extensions: [".txt"],
                access: "read",
              },
            ],
          }),
        );
      }),
    );
    await expect(
      incomplete.inspections.create(
        "https://github.com/example/hello",
        "v1.0.0",
      ),
    ).rejects.toMatchObject({ code: "OPEN_RESOURCE_FILES_INCOMPLETE" });

    const changed = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md"),
          "modified",
        );
        await writeFile(
          join(rootDir, "biunivers.open-resource.json"),
          JSON.stringify({
            protocol: "biunivers.open-resource/1",
            handlers: [
              {
                id: "text",
                actions: ["open"],
                extensions: [".txt"],
                access: "read",
              },
            ],
          }),
        );
      }),
    );
    await expect(
      changed.inspections.create("https://github.com/example/hello", "v1.0.0"),
    ).rejects.toMatchObject({
      code: "OPEN_RESOURCE_PROTOCOL_MISMATCH",
    });
  });

  it("accepts Open Resource v1.1 and rejects a mismatched protocol original", async () => {
    const accepted = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1_1.md"),
          await readFile(openResourceV11ProtocolPath),
        );
        await writeFile(
          join(rootDir, "biunivers.open-resource.json"),
          JSON.stringify({
            protocol: "biunivers.open-resource/1.1",
            handlers: [
              {
                id: "text-many",
                actions: ["open"],
                extensions: [".txt"],
                access: "read",
                multiple: true,
              },
            ],
          }),
        );
      }),
    );
    const inspection = await accepted.inspections.create(
      "https://github.com/example/hello",
      "v1.0.0",
    );
    expect(inspection.openResource).toMatchObject({
      protocol: "biunivers.open-resource/1.1",
      handlers: [{ id: "text-many", multiple: true }],
    });

    const mismatched = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md"),
          await readFile(openResourceProtocolPath),
        );
        await writeFile(
          join(rootDir, "biunivers.open-resource.json"),
          JSON.stringify({
            protocol: "biunivers.open-resource/1.1",
            handlers: [
              {
                id: "text-many",
                actions: ["open"],
                extensions: [".txt"],
                access: "read",
                multiple: true,
              },
            ],
          }),
        );
      }),
    );
    await expect(
      mismatched.inspections.create(
        "https://github.com/example/hello",
        "v1.0.0",
      ),
    ).rejects.toMatchObject({
      code: "OPEN_RESOURCE_PROTOCOL_MISMATCH",
    });
  });

  it("accepts the exact Resource Session protocol and rejects edits", async () => {
    const exact = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md"),
          resourceSessionProtocolBytes,
        );
      }),
    );
    await expect(
      exact.inspections.create("https://github.com/example/hello", "v1.0.0"),
    ).resolves.toMatchObject({
      manifest: { appId: "io.github.example.hello" },
    });

    const changed = await createServices(
      new FixtureSource(async (rootDir) => {
        await writeFile(
          join(rootDir, "BIUNIVERS_RESOURCE_SESSION_PROTOCOL_V1.md"),
          "modified",
        );
      }),
    );
    await expect(
      changed.inspections.create("https://github.com/example/hello", "v1.0.0"),
    ).rejects.toMatchObject({
      code: "RESOURCE_SESSION_PROTOCOL_MISMATCH",
    });
  });

  it("rejects symbolic links and invalid install configuration", async () => {
    const linkedServices = await createServices(
      new FixtureSource(async (rootDir) => {
        await symlink("index.html", join(rootDir, "linked.html"));
      }),
    );
    await expect(
      linkedServices.inspections.create(
        "https://github.com/example/hello",
        "v1.0.0",
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });

    const services = await createServices();
    const inspection = await services.inspections.create(
      "https://github.com/example/hello",
      "v1.0.0",
    );
    await expect(
      services.appService.install(inspection.inspectionId, {
        unknown: true,
      }),
    ).rejects.toMatchObject({ code: "CONFIGURATION_INVALID" });
    await expect(services.appStore.read()).resolves.toMatchObject({
      apps: [],
    });
    await expect(
      readFile(
        join(
          services.dataDir,
          "staging",
          inspection.inspectionId,
          "repository",
          "index.html",
        ),
      ),
    ).resolves.toBeInstanceOf(Buffer);
  });

  it("exposes the two-step flow through authenticated management APIs", async () => {
    const services = await createServices();
    const clientDir = join(services.dataDir, "client");
    await mkdir(clientDir);
    await writeFile(join(clientDir, "index.html"), "<h1>desktop</h1>");
    const config: ServerConfig = {
      adminToken: "a-secure-token-value",
      dataDir: services.dataDir,
      desktopPort: 8080,
      appPort: 8081,
      desktopOrigin: "http://localhost:8080",
      appOrigin: "http://localhost:8081",
      maxAppBytes: 10 * 1024 * 1024,
      maxAppFiles: 100,
    };
    const origin = await listen(
      createDesktopServer({
        config,
        appStore: services.appStore,
        inspections: services.inspections,
        appService: services.appService,
        clientDir,
      }).listen(0, "127.0.0.1"),
    );
    const headers = {
      authorization: `Bearer ${config.adminToken}`,
      "content-type": "application/json",
    };

    const inspectionResponse = await fetch(
      `${origin}/api/v1/admin/inspections`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          repository: "https://github.com/example/hello",
          ref: "v1.0.0",
        }),
      },
    );
    expect(inspectionResponse.status).toBe(201);
    const inspection = (await inspectionResponse.json()) as {
      inspectionId: string;
    };

    const installResponse = await fetch(`${origin}/api/v1/admin/apps`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        inspectionId: inspection.inspectionId,
        configuration: { greeting: "HTTP install" },
      }),
    });
    expect(installResponse.status).toBe(201);

    await expect(
      fetch(`${origin}/api/v1/apps`).then((response) => response.json()),
    ).resolves.toMatchObject({
      apps: [
        {
          id: "io.github.example.hello",
          kind: "iframe",
          url: `${appSpecificOrigin(
            "http://localhost:8081",
            "io.github.example.hello",
          )}/apps/0123456789abcdef0123456789abcdef01234567/index.html`,
        },
      ],
    });
  });

  it("updates, reconfigures, disables, enables and uninstalls atomically", async () => {
    const source = new FixtureSource();
    const services = await createServices(source);
    const firstInspection = await services.inspections.create(
      "https://github.com/example/hello",
      "v1.0.0",
    );
    await services.appService.install(firstInspection.inspectionId, {
      greeting: "first",
    });

    await services.appService.patch("io.github.example.hello", {
      configuration: { greeting: "configured" },
      status: "disabled",
    });
    await expect(services.appStore.read()).resolves.toMatchObject({
      apps: [
        {
          status: "disabled",
          configuration: { greeting: "configured" },
        },
      ],
    });
    await services.appService.patch("io.github.example.hello", {
      status: "active",
    });

    source.commitSha = "abcdef0123456789abcdef0123456789abcdef01";
    source.version = "1.1.0";
    const updateInspection = await services.inspections.create(
      "https://github.com/example/hello",
      "v1.1.0",
    );
    expect(updateInspection.operation).toBe("update");
    await services.appService.update(
      "io.github.example.hello",
      updateInspection.inspectionId,
      { greeting: "updated" },
    );
    await expect(services.appStore.read()).resolves.toMatchObject({
      apps: [
        {
          version: "1.1.0",
          commitSha: source.commitSha,
          configuration: { greeting: "updated" },
          status: "active",
        },
      ],
    });

    const origin = await listen(
      createAppServer({
        appStore: services.appStore,
        dataDir: services.dataDir,
        appOrigin: "http://localhost:8081",
      }).listen(0, "127.0.0.1"),
    );
    const appId = "io.github.example.hello";
    const oldBase = `/apps/${commitSha}`;
    const newBase = `/apps/${source.commitSha}`;
    expect(
      (await fetchApp(origin, appId, `${oldBase}/index.html`)).status,
    ).toBe(200);
    expect(
      (await fetchApp(origin, appId, `${newBase}/index.html`)).status,
    ).toBe(200);
    await expect(
      fetchApp(origin, appId, `${newBase}/.biunivers/config.json`).then(
        (response) => response.json(),
      ),
    ).resolves.toEqual({ greeting: "updated" });

    await services.appService.uninstall("io.github.example.hello");
    await expect(services.appStore.read()).resolves.toMatchObject({
      apps: [],
    });
    expect(
      (await fetchApp(origin, appId, `${newBase}/index.html`)).status,
    ).toBe(404);
  });
});
