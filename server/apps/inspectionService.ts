import { randomUUID } from "node:crypto";
import {
  lstat,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { AppStore } from "./appStore.js";
import { AppError } from "./appError.js";
import type {
  PreparedRepository,
  RepositorySource,
} from "../github/githubSource.js";
import { GitHubSourceError } from "../github/githubSource.js";
import {
  ManifestValidationError,
  type ManifestValidator,
} from "../manifests/manifestValidator.js";
import type { AppManifest } from "../manifests/types.js";

export interface Inspection {
  inspectionId: string;
  repository: string;
  requestedRef: string;
  commitSha: string;
  owner: string;
  rootDir: string;
  manifest: AppManifest;
  operation: "install" | "update";
  expiresAt: string;
}

interface InspectionServiceOptions {
  source: RepositorySource;
  validator: ManifestValidator;
  appStore: AppStore;
  dataDir: string;
  maxAppBytes: number;
  maxAppFiles: number;
  reservedAppIds: ReadonlySet<string>;
  ttlMs?: number;
}

function ensureChildPath(root: string, child: string) {
  const relationship = relative(resolve(root), resolve(child));
  if (
    relationship === "" ||
    relationship === ".." ||
    relationship.startsWith(`..${sep}`) ||
    relationship.startsWith(sep)
  ) {
    throw new AppError("PATH_INVALID", "应用文件路径越过仓库根目录");
  }
}

async function scanRepository(
  rootDir: string,
  maxFiles: number,
  maxBytes: number,
) {
  let files = 0;
  let bytes = 0;

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      ensureChildPath(rootDir, path);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new AppError(
          "UNSUPPORTED_FILE",
          `仓库包含符号链接：${relative(rootDir, path)}`,
        );
      }
      if (stats.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!stats.isFile()) {
        throw new AppError(
          "UNSUPPORTED_FILE",
          `仓库包含不支持的文件：${relative(rootDir, path)}`,
        );
      }
      files += 1;
      bytes += stats.size;
      if (files > maxFiles) {
        throw new AppError("APP_TOO_LARGE", "应用文件数量超过限制");
      }
      if (bytes > maxBytes) {
        throw new AppError("APP_TOO_LARGE", "应用文件总大小超过限制");
      }
    }
  };

  await visit(rootDir);
}

async function requireRegularFile(rootDir: string, relativePath: string) {
  const path = join(rootDir, relativePath);
  ensureChildPath(rootDir, path);
  let stats;
  try {
    stats = await lstat(path);
  } catch {
    throw new AppError(
      "REQUIRED_FILE_MISSING",
      `仓库根目录缺少 ${relativePath}`,
    );
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new AppError(
      "REQUIRED_FILE_INVALID",
      `${relativePath} 必须是普通文件`,
    );
  }
  return path;
}

export class InspectionService {
  private readonly inspections = new Map<string, Inspection>();
  private readonly ttlMs: number;

  constructor(private readonly options: InspectionServiceOptions) {
    this.ttlMs = options.ttlMs ?? 30 * 60 * 1_000;
  }

  async create(repository: string, requestedRef: string) {
    await this.cleanupExpired();
    const inspectionId = randomUUID();
    const stagingDir = join(
      this.options.dataDir,
      "staging",
      inspectionId,
    );

    let prepared: PreparedRepository | undefined;
    try {
      prepared = await this.options.source.prepare(
        repository,
        requestedRef,
        stagingDir,
      );
      await scanRepository(
        prepared.rootDir,
        this.options.maxAppFiles,
        this.options.maxAppBytes,
      );

      const manifestPath = await requireRegularFile(
        prepared.rootDir,
        "biunivers.app.json",
      );
      let manifestValue: unknown;
      try {
        manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch {
        throw new AppError(
          "MANIFEST_INVALID",
          "biunivers.app.json 不是合法 JSON",
        );
      }

      let manifest: AppManifest;
      try {
        manifest = this.options.validator.validate(manifestValue);
      } catch (error) {
        if (error instanceof ManifestValidationError) {
          throw new AppError(
            "MANIFEST_INVALID",
            error.message,
            400,
            error.issues,
          );
        }
        throw error;
      }

      const protocolPath = await requireRegularFile(
        prepared.rootDir,
        "BIUNIVERS_APP_PROTOCOL_V1.md",
      );
      const protocolBytes = await readFile(protocolPath);
      if (!protocolBytes.equals(this.options.validator.protocolBytes)) {
        throw new AppError(
          "PROTOCOL_MISMATCH",
          "BIUNIVERS_APP_PROTOCOL_V1.md 不是宿主支持的协议原文",
        );
      }

      await requireRegularFile(prepared.rootDir, "index.html");
      await requireRegularFile(prepared.rootDir, "LICENSE");
      await requireRegularFile(prepared.rootDir, manifest.icon);

      const expectedPrefix = `io.github.${prepared.owner}.`;
      if (!manifest.appId.startsWith(expectedPrefix)) {
        throw new AppError(
          "APP_ID_OWNER_MISMATCH",
          `appId 必须以 ${expectedPrefix} 开头`,
        );
      }
      if (this.options.reservedAppIds.has(manifest.appId)) {
        throw new AppError(
          "APP_ID_RESERVED",
          `应用 ID ${manifest.appId} 属于内建应用`,
        );
      }

      const state = await this.options.appStore.read();
      const existing = state.apps.find((app) => app.appId === manifest.appId);
      const expiresAt = new Date(Date.now() + this.ttlMs).toISOString();
      const inspection: Inspection = {
        inspectionId,
        repository: prepared.repository,
        requestedRef: prepared.requestedRef,
        commitSha: prepared.commitSha,
        owner: prepared.owner,
        rootDir: prepared.rootDir,
        manifest,
        operation: existing ? "update" : "install",
        expiresAt,
      };
      this.inspections.set(inspectionId, inspection);
      return this.publicResult(inspection);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      if (error instanceof GitHubSourceError) {
        throw new AppError(
          error.code,
          error.message,
          error.status,
        );
      }
      throw error;
    }
  }

  get(inspectionId: string) {
    const inspection = this.inspections.get(inspectionId);
    if (!inspection || Date.parse(inspection.expiresAt) <= Date.now()) {
      this.inspections.delete(inspectionId);
      throw new AppError(
        "INSPECTION_NOT_FOUND",
        "检查记录不存在或已过期",
        404,
      );
    }
    return inspection;
  }

  async consume(inspectionId: string) {
    const inspection = this.get(inspectionId);
    this.inspections.delete(inspectionId);
    const stagingDir = join(
      this.options.dataDir,
      "staging",
      inspectionId,
    );
    await rm(stagingDir, { recursive: true, force: true });
    return inspection;
  }

  async cleanupExpired() {
    const expired = [...this.inspections.values()].filter(
      (inspection) => Date.parse(inspection.expiresAt) <= Date.now(),
    );
    await Promise.all(
      expired.map(async (inspection) => {
        this.inspections.delete(inspection.inspectionId);
        await rm(
          join(
            this.options.dataDir,
            "staging",
            inspection.inspectionId,
          ),
          { recursive: true, force: true },
        );
      }),
    );
  }

  private publicResult(inspection: Inspection) {
    return {
      inspectionId: inspection.inspectionId,
      repository: inspection.repository,
      requestedRef: inspection.requestedRef,
      commitSha: inspection.commitSha,
      operation: inspection.operation,
      expiresAt: inspection.expiresAt,
      manifest: inspection.manifest,
    };
  }
}
