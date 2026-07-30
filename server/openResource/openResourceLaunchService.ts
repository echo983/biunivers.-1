import type { InstalledAppRecord } from "../apps/appStore.js";
import type { EntryIndex, IndexedEntry } from "../files/entryIndex.js";
import {
  FileCapabilityError,
  type FileCapabilityRegistry,
} from "../files/fileCapabilityRegistry.js";
import {
  OpenResourceError,
  type OpenResourceLaunchRegistry,
} from "./openResourceLaunchRegistry.js";
import type { ResourceHandler } from "./types.js";
import type { ResourceSessionService } from "../resources/resourceSessionService.js";
import type { PublicResourceSession } from "../resources/resourceSessionRegistry.js";

interface AppStoreReader {
  read(): Promise<{ apps: InstalledAppRecord[] }>;
}

interface OpenResourceLaunchServiceOptions {
  capabilities: FileCapabilityRegistry;
  launches: OpenResourceLaunchRegistry;
  appStore: AppStoreReader;
  loadIndex: () => Promise<EntryIndex>;
  resourceSessionService?: Pick<ResourceSessionService, "issueFile"> &
    Partial<Pick<ResourceSessionService, "issueFiles">>;
}

export class OpenResourceLaunchService {
  constructor(private readonly options: OpenResourceLaunchServiceOptions) {}

  async create(
    sourceInstanceToken: string,
    input: {
      entryId: string;
      expectedRevision: number;
      targetAppId: string;
      handlerId: string;
      action: "open" | "edit";
    },
  ) {
    const source =
      this.options.capabilities.authorizeInstance(sourceInstanceToken);
    if (source.appId !== "system.files") {
      throw denied("Only the file manager can create a resource launch.");
    }
    const { entry, handler } = await this.#validateTarget(input);
    return {
      targetAppId: input.targetAppId,
      ...this.options.launches.create({
        targetAppId: input.targetAppId,
        handlerId: handler.id,
        entryId: entry.entryIdHex,
        expectedRevision: input.expectedRevision,
        action: input.action,
        writable:
          input.action === "edit" && handler.access === "read-write",
      }),
    };
  }

  async createMany(
    sourceInstanceToken: string,
    input: {
      entryIds: string[];
      expectedRevision: number;
      targetAppId: string;
      handlerId: string;
      action: "open";
    },
  ) {
    const source =
      this.options.capabilities.authorizeInstance(sourceInstanceToken);
    if (source.appId !== "system.files") {
      throw denied("Only the file manager can create a resource launch.");
    }
    const { entries, handler } = await this.#validateManyTarget(input);
    return {
      targetAppId: input.targetAppId,
      ...this.options.launches.create({
        targetAppId: input.targetAppId,
        handlerId: handler.id,
        entryIds: entries.map((entry) => entry.entryIdHex),
        expectedRevision: input.expectedRevision,
        action: "open",
        writable: false,
      }),
    };
  }

  async claim(instanceToken: string, launchId: string) {
    const identity =
      this.options.capabilities.authorizeInstance(instanceToken);
    const launch = this.options.launches.consume(
      launchId,
      identity.appId,
    );
    if (!launch.entryId || launch.entryIds) {
      throw new OpenResourceError(
        "HANDLER_NOT_AVAILABLE",
        "Legacy Host API cannot claim a multi-resource launch.",
      );
    }
    const { entry, handler, index } = await this.#validateTarget({
      entryId: launch.entryId,
      expectedRevision: launch.expectedRevision,
      targetAppId: launch.targetAppId,
      handlerId: launch.handlerId,
      action: launch.action,
    });
    const writable =
      launch.writable &&
      launch.action === "edit" &&
      handler.access === "read-write";
    const handle = this.options.capabilities.issueHandle(
      instanceToken,
      entry,
      index.revision,
      writable,
    );
    return {
      action: launch.action,
      resource: {
        handleId: handle.handleId,
        name: handle.metadata.name,
        permissions: writable ? ["read", "write"] : ["read"],
      },
    };
  }

  async claimResourceSession(
    instanceToken: string,
    launchId: string,
  ): Promise<
    | {
        action: "open" | "edit";
        resource: PublicResourceSession;
      }
    | {
        action: "open";
        resources: PublicResourceSession[];
      }
  > {
    if (!this.options.resourceSessionService) {
      throw denied("Resource sessions are not available.");
    }
    const identity =
      this.options.capabilities.authorizeInstance(instanceToken);
    const launch = this.options.launches.consume(
      launchId,
      identity.appId,
    );
    if (launch.entryIds) {
      const issueFiles = this.options.resourceSessionService.issueFiles;
      if (!issueFiles) {
        throw denied("Multi-resource sessions are not available.");
      }
      await this.#validateManyTarget({
        entryIds: launch.entryIds,
        expectedRevision: launch.expectedRevision,
        targetAppId: launch.targetAppId,
        handlerId: launch.handlerId,
        action: "open",
      });
      return {
        action: "open" as const,
        resources: await issueFiles.call(
          this.options.resourceSessionService,
          instanceToken,
          launch.entryIds,
          launch.handlerId,
          launch.expectedRevision,
        ),
      };
    }
    if (!launch.entryId) {
      throw new OpenResourceError(
        "HANDLER_NOT_AVAILABLE",
        "Resource launch has no valid target.",
      );
    }
    const { entry, handler } = await this.#validateTarget({
      entryId: launch.entryId,
      expectedRevision: launch.expectedRevision,
      targetAppId: launch.targetAppId,
      handlerId: launch.handlerId,
      action: launch.action,
    });
    const access =
      launch.writable &&
      launch.action === "edit" &&
      handler.access === "read-write"
        ? "edit"
        : "read";
    return {
      action: launch.action,
      resource: await this.options.resourceSessionService.issueFile(
        instanceToken,
        entry.entryIdHex,
        access,
      ),
    };
  }

  cancelTarget(targetAppId: string): void {
    this.options.launches.cancelTarget(targetAppId);
  }

  async #validateTarget(input: {
    entryId: string;
    expectedRevision: number;
    targetAppId: string;
    handlerId: string;
    action: "open" | "edit";
  }): Promise<{
    index: EntryIndex;
    entry: IndexedEntry;
    handler: ResourceHandler;
  }> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    ) {
      throw invalid("Expected revision is invalid.");
    }
    const index = await this.options.loadIndex();
    if (index.revision !== input.expectedRevision) {
      throw conflict();
    }
    const entry = index.get(input.entryId);
    if (!entry || entry.kind !== "file") {
      throw new FileCapabilityError(
        "HANDLE_NOT_FOUND",
        "The selected file was not found.",
      );
    }
    const extension = fileExtension(entry.name);
    const state = await this.options.appStore.read();
    const app = state.apps.find(
      (candidate) =>
        candidate.appId === input.targetAppId &&
        candidate.status === "active",
    );
    const handler = app?.openResource?.handlers.find(
      (candidate) =>
        candidate.id === input.handlerId &&
        candidate.actions.includes(input.action) &&
        extension !== null &&
        candidate.extensions.includes(extension),
    );
    if (!handler) {
      throw new OpenResourceError(
        "HANDLER_NOT_AVAILABLE",
        "The selected resource handler is no longer available.",
      );
    }
    return { index, entry, handler };
  }

  async #validateManyTarget(input: {
    entryIds: string[];
    expectedRevision: number;
    targetAppId: string;
    handlerId: string;
    action: "open";
  }): Promise<{
    index: EntryIndex;
    entries: IndexedEntry[];
    handler: ResourceHandler;
  }> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0 ||
      input.entryIds.length < 2 ||
      input.entryIds.length > 100 ||
      new Set(input.entryIds).size !== input.entryIds.length
    ) {
      throw invalid("Multi-resource launch is invalid.");
    }
    const index = await this.options.loadIndex();
    if (index.revision !== input.expectedRevision) {
      throw conflict();
    }
    const entries = input.entryIds.map((entryId) => index.get(entryId));
    if (entries.some((entry) => !entry || entry.kind !== "file")) {
      throw new FileCapabilityError(
        "HANDLE_NOT_FOUND",
        "One or more selected files were not found.",
      );
    }
    const files = entries.filter(
      (entry): entry is NonNullable<typeof entry> =>
        Boolean(entry && entry.kind === "file"),
    );
    const state = await this.options.appStore.read();
    const app = state.apps.find(
      (candidate) =>
        candidate.appId === input.targetAppId &&
        candidate.status === "active" &&
        candidate.openResource?.protocol ===
          "biunivers.open-resource/1.1",
    );
    const handler = app?.openResource?.handlers.find(
      (candidate) =>
        candidate.id === input.handlerId &&
        candidate.multiple === true &&
        candidate.actions.includes("open") &&
        files.every((entry) => {
          const extension = fileExtension(entry.name);
          return (
            extension !== null &&
            candidate.extensions.includes(extension)
          );
        }),
    );
    if (!handler) {
      throw new OpenResourceError(
        "HANDLER_NOT_AVAILABLE",
        "The selected multi-resource handler is no longer available.",
      );
    }
    return { index, entries: files, handler };
  }
}

function fileExtension(name: string): string | null {
  const lastDot = name.lastIndexOf(".");
  return lastDot <= 0 || lastDot === name.length - 1
    ? null
    : name.slice(lastDot).toLowerCase();
}

function invalid(message: string) {
  return new FileCapabilityError("REQUEST_INVALID", message);
}

function denied(message: string) {
  return new FileCapabilityError("PERMISSION_DENIED", message);
}

function conflict() {
  return new FileCapabilityError(
    "FILE_VERSION_CONFLICT",
    "The file system changed; refresh and try again.",
  );
}
