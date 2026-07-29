import { readFile } from "node:fs/promises";
import {
  Ajv,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import type { ManifestValidationIssue } from "../manifests/manifestValidator.js";
import type { OpenResourceDeclaration } from "./types.js";

export class OpenResourceValidationError extends Error {
  constructor(readonly issues: ManifestValidationIssue[]) {
    super("biunivers.open-resource.json 校验失败");
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) => ({
    path: error.instancePath.replace(/^\//, "").replaceAll("/", "."),
    message: error.message ?? "字段无效",
  }));
}

export class OpenResourceValidator {
  private constructor(
    private readonly validateSchema: ValidateFunction<OpenResourceDeclaration>,
    readonly protocolBytes: Buffer,
  ) {}

  static async create(schemaPath: string, protocolPath: string) {
    const [schemaContent, protocolBytes] = await Promise.all([
      readFile(schemaPath, "utf8"),
      readFile(protocolPath),
    ]);
    const schema = JSON.parse(schemaContent) as AnySchema;
    const ajv = new Ajv({ allErrors: true, strict: true });
    return new OpenResourceValidator(
      ajv.compile<OpenResourceDeclaration>(schema),
      protocolBytes,
    );
  }

  validate(value: unknown): OpenResourceDeclaration {
    if (!this.validateSchema(value)) {
      throw new OpenResourceValidationError(
        formatAjvErrors(this.validateSchema.errors),
      );
    }

    const ids = new Set<string>();
    const issues: ManifestValidationIssue[] = [];
    value.handlers.forEach((handler, index) => {
      if (ids.has(handler.id)) {
        issues.push({
          path: `handlers.${index}.id`,
          message: "Handler ID 不能重复",
        });
      }
      ids.add(handler.id);
    });
    if (issues.length > 0) {
      throw new OpenResourceValidationError(issues);
    }
    return value;
  }
}
