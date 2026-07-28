import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ManifestValidationError,
  type ManifestValidator,
} from "../manifests/manifestValidator.js";
import type { ConfigurationValue } from "../manifests/types.js";
import { AppError } from "./appError.js";
import type { AppStore, InstalledAppRecord } from "./appStore.js";
import type { InspectionService } from "./inspectionService.js";
import type { OperationLock } from "./operationLock.js";

interface AppServiceOptions {
  appStore: AppStore;
  inspections: InspectionService;
  validator: ManifestValidator;
  operationLock: OperationLock;
  dataDir: string;
}

export class AppService {
  constructor(private readonly options: AppServiceOptions) {}

  private validateConfiguration(
    definitions: Parameters<
      ManifestValidator["validateConfiguration"]
    >[0],
    configuration: unknown,
  ) {
    try {
      return this.options.validator.validateConfiguration(
        definitions,
        configuration,
      );
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        throw new AppError(
          "CONFIGURATION_INVALID",
          "安装配置校验失败",
          400,
          error.issues,
        );
      }
      throw error;
    }
  }

  install(inspectionId: string, configuration: unknown) {
    return this.options.operationLock.run(async () => {
      const inspection = this.options.inspections.get(inspectionId);
      if (inspection.operation !== "install") {
        throw new AppError(
          "APP_ALREADY_INSTALLED",
          "该应用已经安装，请使用更新操作",
          409,
        );
      }

      const finalConfiguration: Record<string, ConfigurationValue> =
        this.validateConfiguration(
          inspection.manifest.configuration,
          configuration,
        );
      const state = await this.options.appStore.read();
      if (state.apps.some((app) => app.appId === inspection.manifest.appId)) {
        throw new AppError(
          "APP_ID_CONFLICT",
          `应用 ID ${inspection.manifest.appId} 已存在`,
          409,
        );
      }

      const versionDir = join(
        this.options.dataDir,
        "apps",
        inspection.manifest.appId,
        inspection.commitSha,
      );
      await mkdir(dirname(versionDir), { recursive: true });
      try {
        await rename(inspection.rootDir, versionDir);
      } catch (error) {
        throw new AppError(
          "INSTALL_FILES_FAILED",
          "无法把应用文件移入正式目录",
          500,
          error instanceof Error ? error.message : undefined,
        );
      }

      const now = new Date().toISOString();
      const record: InstalledAppRecord = {
        appId: inspection.manifest.appId,
        repository: inspection.repository,
        requestedRef: inspection.requestedRef,
        commitSha: inspection.commitSha,
        version: inspection.manifest.version,
        protocol: inspection.manifest.protocol,
        manifest: inspection.manifest,
        configuration: finalConfiguration,
        status: "active",
        installedAt: now,
        updatedAt: now,
      };

      try {
        await this.options.appStore.write({
          schemaVersion: 1,
          apps: [...state.apps, record],
        });
      } catch (error) {
        await rm(versionDir, { recursive: true, force: true });
        throw error;
      }

      await this.options.inspections.consume(inspectionId);
      return record;
    });
  }

  update(
    appId: string,
    inspectionId: string,
    configuration: unknown,
  ) {
    return this.options.operationLock.run(async () => {
      const inspection = this.options.inspections.get(inspectionId);
      if (
        inspection.operation !== "update" ||
        inspection.manifest.appId !== appId
      ) {
        throw new AppError(
          "UPDATE_MISMATCH",
          "检查结果不属于当前已安装应用",
          409,
        );
      }

      const state = await this.options.appStore.read();
      const currentIndex = state.apps.findIndex(
        (app) => app.appId === appId,
      );
      if (currentIndex < 0) {
        throw new AppError("APP_NOT_FOUND", "应用尚未安装", 404);
      }
      const current = state.apps[currentIndex];
      if (current.commitSha === inspection.commitSha) {
        throw new AppError(
          "VERSION_UNCHANGED",
          "目标 commit 与当前版本相同",
          409,
        );
      }

      const finalConfiguration = this.validateConfiguration(
        inspection.manifest.configuration,
        configuration,
      );
      const versionDir = join(
        this.options.dataDir,
        "apps",
        appId,
        inspection.commitSha,
      );
      await mkdir(dirname(versionDir), { recursive: true });
      try {
        await rename(inspection.rootDir, versionDir);
      } catch (error) {
        throw new AppError(
          "INSTALL_FILES_FAILED",
          "无法把新版本文件移入正式目录",
          500,
          error instanceof Error ? error.message : undefined,
        );
      }

      const updated: InstalledAppRecord = {
        ...current,
        repository: inspection.repository,
        requestedRef: inspection.requestedRef,
        commitSha: inspection.commitSha,
        version: inspection.manifest.version,
        protocol: inspection.manifest.protocol,
        manifest: inspection.manifest,
        configuration: finalConfiguration,
        updatedAt: new Date().toISOString(),
      };
      const apps = [...state.apps];
      apps[currentIndex] = updated;

      try {
        await this.options.appStore.write({ schemaVersion: 1, apps });
      } catch (error) {
        await rm(versionDir, { recursive: true, force: true });
        throw error;
      }

      await this.options.inspections.consume(inspectionId);
      return updated;
    });
  }

  patch(
    appId: string,
    patch: { configuration?: unknown; status?: unknown },
  ) {
    return this.options.operationLock.run(async () => {
      const state = await this.options.appStore.read();
      const index = state.apps.findIndex((app) => app.appId === appId);
      if (index < 0) {
        throw new AppError("APP_NOT_FOUND", "应用尚未安装", 404);
      }
      if (
        patch.status !== undefined &&
        patch.status !== "active" &&
        patch.status !== "disabled"
      ) {
        throw new AppError(
          "STATUS_INVALID",
          "status 必须是 active 或 disabled",
        );
      }
      if (
        patch.status === undefined &&
        !Object.hasOwn(patch, "configuration")
      ) {
        throw new AppError(
          "REQUEST_INVALID",
          "至少需要提供 configuration 或 status",
        );
      }

      const current = state.apps[index];
      const configuration = Object.hasOwn(patch, "configuration")
        ? this.validateConfiguration(
            current.manifest.configuration,
            patch.configuration,
          )
        : current.configuration;
      const updated: InstalledAppRecord = {
        ...current,
        configuration,
        status:
          patch.status === "active" || patch.status === "disabled"
            ? patch.status
            : current.status,
        updatedAt: new Date().toISOString(),
      };
      const apps = [...state.apps];
      apps[index] = updated;
      await this.options.appStore.write({ schemaVersion: 1, apps });
      return updated;
    });
  }

  uninstall(appId: string) {
    return this.options.operationLock.run(async () => {
      const state = await this.options.appStore.read();
      const installed = state.apps.find((app) => app.appId === appId);
      if (!installed) {
        throw new AppError("APP_NOT_FOUND", "应用尚未安装", 404);
      }

      await this.options.appStore.write({
        schemaVersion: 1,
        apps: state.apps.filter((app) => app.appId !== appId),
      });

      const sourceDir = join(this.options.dataDir, "apps", appId);
      const trashDir = join(
        this.options.dataDir,
        "trash",
        `${appId}-${randomUUID()}`,
      );
      try {
        await rename(sourceDir, trashDir);
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "ENOENT"
        ) {
          console.warn("Unable to move uninstalled app to trash", error);
        }
      }
      return installed;
    });
  }
}
