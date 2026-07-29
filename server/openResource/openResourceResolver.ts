import type { InstalledAppRecord } from "../apps/appStore.js";
import type { FileCapabilityRegistry } from "../files/fileCapabilityRegistry.js";
import { FileCapabilityError } from "../files/fileCapabilityRegistry.js";
import type { EntryIndex } from "../files/entryIndex.js";
import type { ResourceHandler } from "./types.js";

const INTERNAL_FILE_APP_ID = "system.files";

interface AppStoreReader {
  read(): Promise<{ apps: InstalledAppRecord[] }>;
}

export interface ResourceHandlerCandidate {
  appId: string;
  appName: string;
  handler: ResourceHandler;
}

interface OpenResourceResolverOptions {
  capabilities: FileCapabilityRegistry;
  appStore: AppStoreReader;
  loadIndex: () => Promise<EntryIndex>;
}

export class OpenResourceResolver {
  constructor(private readonly options: OpenResourceResolverOptions) {}

  async resolve(
    instanceToken: string,
    input: {
      entryId: string;
      expectedRevision: number;
      requestedAction: "open" | "edit";
    },
  ) {
    const identity =
      this.options.capabilities.authorizeInstance(instanceToken);
    if (identity.appId !== INTERNAL_FILE_APP_ID) {
      throw denied();
    }
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
      throw notFound();
    }
    const extension = fileExtension(entry.name);
    const state = await this.options.appStore.read();
    const candidates = candidatesFor(
      state.apps,
      extension,
      input.requestedAction,
    );
    const effectiveAction =
      input.requestedAction === "edit" && candidates.length === 0
        ? "open"
        : input.requestedAction;
    const effectiveCandidates =
      effectiveAction === input.requestedAction
        ? candidates
        : candidatesFor(state.apps, extension, effectiveAction);

    return {
      entryId: entry.entryIdHex,
      name: entry.name,
      extension,
      revision: index.revision,
      requestedAction: input.requestedAction,
      effectiveAction,
      candidates: effectiveCandidates,
    };
  }
}

function candidatesFor(
  apps: InstalledAppRecord[],
  extension: string | null,
  action: "open" | "edit",
): ResourceHandlerCandidate[] {
  if (!extension) {
    return [];
  }
  return apps
    .filter((app) => app.status === "active" && app.openResource)
    .flatMap((app) =>
      (app.openResource?.handlers ?? [])
        .filter(
          (handler) =>
            handler.actions.includes(action) &&
            handler.extensions.includes(extension),
        )
        .map((handler) => ({
          appId: app.appId,
          appName: app.manifest.name,
          handler,
        })),
    )
    .sort((left, right) =>
      left.appName.localeCompare(right.appName) ||
      left.appId.localeCompare(right.appId) ||
      left.handler.id.localeCompare(right.handler.id),
    );
}

function fileExtension(name: string): string | null {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return null;
  }
  return name.slice(lastDot).toLowerCase();
}

function invalid(message: string) {
  return new FileCapabilityError("REQUEST_INVALID", message);
}

function denied() {
  return new FileCapabilityError(
    "PERMISSION_DENIED",
    "Resource resolution is restricted to the file manager.",
  );
}

function notFound() {
  return new FileCapabilityError(
    "HANDLE_NOT_FOUND",
    "The selected file was not found.",
  );
}

function conflict() {
  return new FileCapabilityError(
    "FILE_VERSION_CONFLICT",
    "The file system changed; refresh and try again.",
  );
}
