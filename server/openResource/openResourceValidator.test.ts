// @vitest-environment node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  OpenResourceValidationError,
  OpenResourceValidator,
} from "./openResourceValidator.js";

let validator: OpenResourceValidator;

beforeAll(async () => {
  validator = await OpenResourceValidator.create(
    resolve(
      "docs",
      "developer-kit",
      "v1",
      "biunivers.open-resource.schema.json",
    ),
    resolve(
      "docs",
      "developer-kit",
      "v1",
      "BIUNIVERS_OPEN_RESOURCE_PROTOCOL_V1.md",
    ),
  );
});

const textHandler = {
  id: "text-editor",
  actions: ["open", "edit"],
  extensions: [".txt", ".md"],
  mediaTypes: ["text/plain", "text/markdown"],
  access: "read-write",
};

describe("OpenResourceValidator", () => {
  it("accepts the frozen text handler declaration", () => {
    expect(
      validator.validate({
        protocol: "biunivers.open-resource/1",
        handlers: [textHandler],
      }),
    ).toEqual({
      protocol: "biunivers.open-resource/1",
      handlers: [textHandler],
    });
  });

  it("accepts the resource application template declaration", async () => {
    const declaration = JSON.parse(
      await readFile(
        resolve(
          "docs",
          "developer-kit",
          "v1",
          "template",
          "resource-app",
          "biunivers.open-resource.json",
        ),
        "utf8",
      ),
    );
    expect(validator.validate(declaration).handlers).toHaveLength(1);
  });

  it("rejects edit handlers without read-write access", () => {
    expect(() =>
      validator.validate({
        protocol: "biunivers.open-resource/1",
        handlers: [{ ...textHandler, access: "read" }],
      }),
    ).toThrow(OpenResourceValidationError);
  });

  it("rejects duplicate handler identities", () => {
    expect(() =>
      validator.validate({
        protocol: "biunivers.open-resource/1",
        handlers: [textHandler, { ...textHandler, extensions: [".log"] }],
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: [
          {
            path: "handlers.1.id",
            message: "Handler ID 不能重复",
          },
        ],
      }),
    );
  });
});
