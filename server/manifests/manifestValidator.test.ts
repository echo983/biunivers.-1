// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ManifestValidationError,
  ManifestValidator,
} from "./manifestValidator.js";

let validator: ManifestValidator;
let manifest: unknown;

beforeAll(async () => {
  const kit = resolve("docs", "developer-kit", "v1");
  validator = await ManifestValidator.create(
    resolve(kit, "biunivers.app.schema.json"),
    resolve(kit, "BIUNIVERS_APP_PROTOCOL_V1.md"),
  );
  manifest = JSON.parse(
    await readFile(
      resolve(kit, "template", "minimal-app", "biunivers.app.json"),
      "utf8",
    ),
  );
});

describe("ManifestValidator", () => {
  it("accepts the developer kit template and applies configuration defaults", () => {
    const validated = validator.validate(manifest);
    expect(validated.appId).toBe("io.github.example.hello");
    expect(
      validator.validateConfiguration(validated.configuration, {}),
    ).toEqual({ greeting: "你好，Biunivers" });
  });

  it("rejects duplicate configuration keys and invalid window constraints", () => {
    const invalid = structuredClone(manifest) as {
      window: { minWidth: number; defaultWidth: number };
      configuration: unknown[];
    };
    invalid.window.minWidth = invalid.window.defaultWidth + 1;
    invalid.configuration.push(invalid.configuration[0]);

    expect(() => validator.validate(invalid)).toThrow(
      ManifestValidationError,
    );
  });

  it("rejects unknown and invalid configuration values", () => {
    const validated = validator.validate(manifest);

    expect(() =>
      validator.validateConfiguration(validated.configuration, {
        greeting: false,
        secret: "no",
      }),
    ).toThrow(ManifestValidationError);
  });
});
