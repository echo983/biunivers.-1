// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestValidator } from "../manifests/manifestValidator.js";

const fixtureRoot = resolve("examples", "notepad-app");
const protocolPath = resolve(
  "docs",
  "developer-kit",
  "v1",
  "BIUNIVERS_APP_PROTOCOL_V1.md",
);

describe("Biunivers Notepad validation fixture", () => {
  it("is a complete installable static-app package", async () => {
    const validator = await ManifestValidator.create(
      resolve("docs", "developer-kit", "v1", "biunivers.app.schema.json"),
      protocolPath,
    );
    const [manifestBytes, protocolBytes, expectedProtocol, index, app] =
      await Promise.all([
        readFile(resolve(fixtureRoot, "biunivers.app.json")),
        readFile(resolve(fixtureRoot, "BIUNIVERS_APP_PROTOCOL_V1.md")),
        readFile(protocolPath),
        readFile(resolve(fixtureRoot, "index.html"), "utf8"),
        readFile(resolve(fixtureRoot, "app.js"), "utf8"),
      ]);

    expect(protocolBytes.equals(expectedProtocol)).toBe(true);
    expect(
      validator.validate(JSON.parse(manifestBytes.toString("utf8"))),
    ).toMatchObject({
      appId: "io.github.echo983.biunivers-notepad",
      protocol: "biunivers.static-app/1",
      version: "0.1.0",
    });
    expect(index).toContain('src="./app.js"');
    for (const method of [
      "file.open",
      "file.saveAs",
      "file.readTransfer",
      "file.writeTransfer",
      "file.getMetadata",
      "file.release",
    ]) {
      expect(app).toContain(`"${method}"`);
    }
  });
});
