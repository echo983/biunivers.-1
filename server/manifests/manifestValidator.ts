import { readFile } from "node:fs/promises";
import {
  Ajv,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import type {
  AppManifest,
  ConfigurationDefinition,
  ConfigurationValue,
} from "./types.js";

export interface ManifestValidationIssue {
  path: string;
  message: string;
}

export class ManifestValidationError extends Error {
  constructor(readonly issues: ManifestValidationIssue[]) {
    super("biunivers.app.json 校验失败");
  }
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined) {
  return (errors ?? []).map((error) => ({
    path: error.instancePath.replace(/^\//, "").replaceAll("/", "."),
    message: error.message ?? "字段无效",
  }));
}

function validateConfigurationDefinitions(
  definitions: ConfigurationDefinition[],
) {
  const issues: ManifestValidationIssue[] = [];
  const keys = new Set<string>();

  definitions.forEach((definition, index) => {
    const path = `configuration.${index}`;
    if (keys.has(definition.key)) {
      issues.push({ path: `${path}.key`, message: "配置 key 不能重复" });
    }
    keys.add(definition.key);

    if (
      "minimum" in definition &&
      "maximum" in definition &&
      definition.minimum !== undefined &&
      definition.maximum !== undefined &&
      definition.minimum > definition.maximum
    ) {
      issues.push({
        path,
        message: "minimum 不能大于 maximum",
      });
    }

    if (
      definition.type === "select" &&
      definition.default !== undefined &&
      !definition.options.includes(definition.default)
    ) {
      issues.push({
        path: `${path}.default`,
        message: "默认值必须包含在 options 中",
      });
    }
  });

  return issues;
}

export class ManifestValidator {
  private constructor(
    private readonly validateSchema: ValidateFunction<AppManifest>,
    readonly protocolBytes: Buffer,
  ) {}

  static async create(schemaPath: string, protocolPath: string) {
    const [schemaContent, protocolBytes] = await Promise.all([
      readFile(schemaPath, "utf8"),
      readFile(protocolPath),
    ]);
    const schema = JSON.parse(schemaContent) as AnySchema;
    const ajv = new Ajv({ allErrors: true, strict: true });
    const validateSchema = ajv.compile<AppManifest>(schema);
    return new ManifestValidator(validateSchema, protocolBytes);
  }

  validate(value: unknown): AppManifest {
    if (!this.validateSchema(value)) {
      throw new ManifestValidationError(
        formatAjvErrors(this.validateSchema.errors),
      );
    }

    const manifest = value;
    const issues = validateConfigurationDefinitions(manifest.configuration);
    if (
      manifest.window.minWidth !== undefined &&
      manifest.window.minWidth > manifest.window.defaultWidth
    ) {
      issues.push({
        path: "window.minWidth",
        message: "不能大于 defaultWidth",
      });
    }
    if (
      manifest.window.minHeight !== undefined &&
      manifest.window.minHeight > manifest.window.defaultHeight
    ) {
      issues.push({
        path: "window.minHeight",
        message: "不能大于 defaultHeight",
      });
    }

    if (issues.length > 0) {
      throw new ManifestValidationError(issues);
    }
    return manifest;
  }

  validateConfiguration(
    definitions: ConfigurationDefinition[],
    input: unknown,
  ) {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new ManifestValidationError([
        { path: "configuration", message: "必须是对象" },
      ]);
    }

    const provided = input as Record<string, unknown>;
    const knownKeys = new Set(definitions.map((definition) => definition.key));
    const issues: ManifestValidationIssue[] = [];
    const result: Record<string, ConfigurationValue> = {};

    for (const key of Object.keys(provided)) {
      if (!knownKeys.has(key)) {
        issues.push({ path: key, message: "配置项未在 manifest 中声明" });
      }
    }

    for (const definition of definitions) {
      const value = Object.hasOwn(provided, definition.key)
        ? provided[definition.key]
        : definition.default;
      if (value === undefined) {
        if (definition.required) {
          issues.push({ path: definition.key, message: "必填配置缺失" });
        }
        continue;
      }

      const validType =
        (definition.type === "string" && typeof value === "string") ||
        (definition.type === "boolean" && typeof value === "boolean") ||
        (definition.type === "integer" &&
          typeof value === "number" &&
          Number.isSafeInteger(value)) ||
        (definition.type === "number" &&
          typeof value === "number" &&
          Number.isFinite(value)) ||
        (definition.type === "select" &&
          typeof value === "string" &&
          definition.options.includes(value));

      if (!validType) {
        issues.push({ path: definition.key, message: "配置值类型或选项无效" });
        continue;
      }

      if (
        typeof value === "number" &&
        "minimum" in definition &&
        definition.minimum !== undefined &&
        value < definition.minimum
      ) {
        issues.push({ path: definition.key, message: "配置值低于 minimum" });
        continue;
      }
      if (
        typeof value === "number" &&
        "maximum" in definition &&
        definition.maximum !== undefined &&
        value > definition.maximum
      ) {
        issues.push({ path: definition.key, message: "配置值高于 maximum" });
        continue;
      }
      result[definition.key] = value as ConfigurationValue;
    }

    if (issues.length > 0) {
      throw new ManifestValidationError(issues);
    }
    return result;
  }
}
