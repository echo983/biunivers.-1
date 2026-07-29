import type { AppStore, InstalledAppRecord } from "../apps/appStore.js";
import type { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { loadCurrentEntryIndex } from "../files/entryIndex.js";
import { validateEntryName } from "../files/entryName.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type { SqliteRefStore } from "../files/sqliteRefStore.js";
import {
  ResourceSessionError,
  ResourceSessionRegistry,
  type ResourceAccess,
} from "./resourceSessionRegistry.js";

interface ResourceSessionServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  capabilities: FileCapabilityRegistry;
  sessions: ResourceSessionRegistry;
  appStore: AppStore;
}

export class ResourceSessionService {
  constructor(private readonly options: ResourceSessionServiceOptions) {}

  async issueFile(
    instanceToken: string,
    entryId: string,
    access: ResourceAccess,
  ) {
    const app = await this.#activeApp(instanceToken);
    const index = await loadCurrentEntryIndex(
      this.options.repository,
      this.options.refStore,
    );
    const entry = index.get(entryId);
    if (!entry || entry.kind !== "file" || !entry.content) {
      throw notFound();
    }
    this.#requireHandler(app, entry.name, access);
    return this.options.sessions.issueFile(
      app.appId,
      entry,
      index.revision,
      access,
      mediaTypeFromName(entry.name),
    );
  }

  async issueSaveTarget(
    instanceToken: string,
    parentEntryId: string,
    name: string,
  ) {
    const app = await this.#activeApp(instanceToken);
    validateEntryName(name);
    this.#requireHandler(app, name, "edit");
    const index = await loadCurrentEntryIndex(
      this.options.repository,
      this.options.refStore,
    );
    const parent = index.get(parentEntryId);
    if (!parent || parent.kind !== "directory") {
      throw notFound();
    }
    if (
      index
        .listChildren(parentEntryId)
        .some((entry) => entry.name === name)
    ) {
      throw new ResourceSessionError(
        "REQUEST_INVALID",
        "A file with this name already exists.",
      );
    }
    return this.options.sessions.issuePendingFile(
      app.appId,
      parentEntryId,
      name,
      index.revision,
      mediaTypeFromName(name),
    );
  }

  async metadata(instanceToken: string, sessionId: string) {
    const app = await this.#activeApp(instanceToken);
    return this.options.sessions.touch(app.appId, sessionId);
  }

  async renew(instanceToken: string, sessionIds: readonly string[]) {
    const app = await this.#activeApp(instanceToken);
    return this.options.sessions.renew(app.appId, sessionIds);
  }

  async release(instanceToken: string, sessionIds: readonly string[]) {
    const identity =
      this.options.capabilities.authorizeInstance(instanceToken);
    this.options.sessions.release(identity.appId, sessionIds);
  }

  async #activeApp(instanceToken: string): Promise<InstalledAppRecord> {
    const identity =
      this.options.capabilities.authorizeInstance(instanceToken);
    const state = await this.options.appStore.read();
    const app = state.apps.find(
      (candidate) =>
        candidate.appId === identity.appId &&
        candidate.status === "active",
    );
    if (!app) {
      this.options.sessions.revokeApp(identity.appId);
      throw new ResourceSessionError(
        "RESOURCE_SESSION_REVOKED",
        "Application is no longer active.",
      );
    }
    return app;
  }

  #requireHandler(
    app: InstalledAppRecord,
    name: string,
    access: ResourceAccess,
  ): void {
    const extension = fileExtension(name);
    const allowed = app.openResource?.handlers.some(
      (handler) =>
        extension !== null &&
        handler.extensions.includes(extension) &&
        (access === "read"
          ? handler.actions.includes("open") ||
            handler.actions.includes("edit")
          : handler.actions.includes("edit") &&
            handler.access === "read-write"),
    );
    if (!allowed) {
      throw new ResourceSessionError(
        "RESOURCE_ACCESS_DENIED",
        "Application has no matching resource handler.",
      );
    }
  }
}

function fileExtension(name: string): string | null {
  const lastDot = name.lastIndexOf(".");
  return lastDot <= 0 || lastDot === name.length - 1
    ? null
    : name.slice(lastDot).toLowerCase();
}

function mediaTypeFromName(name: string): string {
  const extension = fileExtension(name);
  return (
    {
      ".txt": "text/plain",
      ".md": "text/markdown",
      ".json": "application/json",
      ".pdf": "application/pdf",
      ".mp4": "video/mp4",
      ".mkv": "video/x-matroska",
      ".webm": "video/webm",
      ".mp3": "audio/mpeg",
      ".wav": "audio/wav",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

function notFound(): ResourceSessionError {
  return new ResourceSessionError(
    "RESOURCE_SESSION_NOT_FOUND",
    "Selected file or directory was not found.",
  );
}
