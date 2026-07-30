import { readFile } from "node:fs/promises";
import {
  Ajv,
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";
import type { ManifestValidationIssue } from "../manifests/manifestValidator.js";
import type { OpenResourceDeclaration } from "./types.js";
import type { OpenResourceProtocol } from "./types.js";

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
    private readonly definitions: Map<
      OpenResourceProtocol,
      {
        validateSchema: ValidateFunction<OpenResourceDeclaration>;
        protocolBytes: Buffer;
        protocolFileName: string;
      }
    >,
  ) {}

  static async create(schemaPath: string, protocolPath: string) {
    const schemaContent = await readFile(schemaPath, "utf8");
    const schema = JSON.parse(schemaContent) as AnySchema & {
      properties?: { protocol?: { const?: OpenResourceProtocol } };
    };
    const protocol = schema.properties?.protocol?.const;
    if (!protocol) {
      throw new Error("Open Resource schema 缺少固定 protocol");
    }
    return this.createRegistry([
      {
        protocol,
        schemaPath,
        protocolPath,
        protocolFileName: protocolPath.split(/[\\/]/).at(-1) ?? protocolPath,
      },
    ]);
  }

  static async createRegistry(
    definitions: Array<{
      protocol: OpenResourceProtocol;
      schemaPath: string;
      protocolPath: string;
      protocolFileName: string;
    }>,
  ) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    const compiled = new Map<
      OpenResourceProtocol,
      {
        validateSchema: ValidateFunction<OpenResourceDeclaration>;
        protocolBytes: Buffer;
        protocolFileName: string;
      }
    >();
    for (const definition of definitions) {
      const [schemaContent, protocolBytes] = await Promise.all([
        readFile(definition.schemaPath, "utf8"),
        readFile(definition.protocolPath),
      ]);
      const schema = JSON.parse(schemaContent) as AnySchema;
      compiled.set(definition.protocol, {
        validateSchema: ajv.compile<OpenResourceDeclaration>(schema),
        protocolBytes,
        protocolFileName: definition.protocolFileName,
      });
    }
    return new OpenResourceValidator(compiled);
  }

  get supportedProtocolFileNames() {
    return [...this.definitions.values()].map(
      (definition) => definition.protocolFileName,
    );
  }

  protocolFileName(protocol: OpenResourceProtocol) {
    return this.definition(protocol).protocolFileName;
  }

  protocolBytesFor(protocol: OpenResourceProtocol) {
    return this.definition(protocol).protocolBytes;
  }

  get protocolBytes() {
    if (this.definitions.size !== 1) {
      throw new Error("多版本校验器必须按协议版本读取原文");
    }
    return this.definitions.values().next().value!.protocolBytes;
  }

  private definition(protocol: OpenResourceProtocol) {
    const definition = this.definitions.get(protocol);
    if (!definition) {
      throw new OpenResourceValidationError([
        {
          path: "protocol",
          message: "不是宿主支持的 Open Resource 协议版本",
        },
      ]);
    }
    return definition;
  }

  validate(value: unknown): OpenResourceDeclaration {
    const protocol =
      typeof value === "object" &&
      value !== null &&
      "protocol" in value &&
      typeof value.protocol === "string"
        ? (value.protocol as OpenResourceProtocol)
        : undefined;
    if (!protocol) {
      throw new OpenResourceValidationError([
        { path: "protocol", message: "必须提供协议版本" },
      ]);
    }
    const validateSchema = this.definition(protocol).validateSchema;
    if (!validateSchema(value)) {
      throw new OpenResourceValidationError(
        formatAjvErrors(validateSchema.errors),
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
