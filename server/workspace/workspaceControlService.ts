import {
  FileCapabilityError,
  type FileCapabilityRegistry,
} from "../files/fileCapabilityRegistry.js";
import {
  buildDirectoryBreadcrumbs,
  type PublicFileEntry,
} from "../files/fileHostService.js";
import {
  loadCurrentEntryIndex,
  type IndexedEntry,
} from "../files/entryIndex.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type {
  SqliteRefStore,
  WorkspaceRecord,
  WorkspaceRetention,
} from "../files/sqliteRefStore.js";
import { WorkspaceDeriver } from "./workspaceDeriver.js";

const FILES_APP_ID = "system.files";
const WORKSPACES_APP_ID = "system.workspaces";

export interface WorkspaceSummary extends WorkspaceRecord {
  revision: number;
}

interface WorkspaceControlServiceOptions {
  repository: ImmutableObjectRepository;
  refStore: SqliteRefStore;
  capabilities: FileCapabilityRegistry;
  writerId: string;
  deriver?: WorkspaceDeriver;
  now?: () => number;
}

export class WorkspaceControlService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #capabilities: FileCapabilityRegistry;
  readonly #deriver: WorkspaceDeriver;
  readonly #now: () => number;

  constructor(options: WorkspaceControlServiceOptions) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#capabilities = options.capabilities;
    this.#deriver =
      options.deriver ??
      new WorkspaceDeriver({
        repository: options.repository,
        refStore: options.refStore,
        writerId: options.writerId,
      });
    this.#now = options.now ?? Date.now;
  }

  async create(
    instanceToken: string,
    input: {
      name: string;
      selectedEntryIds: string[];
      retention?: WorkspaceRetention;
    },
  ): Promise<{
    workspace: WorkspaceSummary;
    rootEntryIdHex: string;
    checkpointFidHex: string;
    entryCount: number;
  }> {
    this.#authorize(instanceToken, FILES_APP_ID);
    const result = await this.#deriver.derive({
      name: input.name,
      selectedEntryIdsHex: input.selectedEntryIds,
      retention: input.retention,
    });
    return {
      ...result,
      workspace: { ...result.workspace, revision: 0 },
    };
  }

  list(instanceToken: string): WorkspaceSummary[] {
    this.#authorize(instanceToken, WORKSPACES_APP_ID);
    return this.#refStore.listWorkspaces().map((workspace) => ({
      ...workspace,
      revision: this.#refStore.getRef(workspace.refId).revision,
    }));
  }

  setRetention(
    instanceToken: string,
    workspaceIdHex: string,
    retention: WorkspaceRetention,
  ): WorkspaceSummary {
    this.#authorize(instanceToken, WORKSPACES_APP_ID);
    const workspace = this.#refStore.setWorkspaceRetention(
      workspaceIdHex,
      retention,
      this.#now(),
    );
    return {
      ...workspace,
      revision: this.#refStore.getRef(workspace.refId).revision,
    };
  }

  delete(instanceToken: string, workspaceIdHex: string): void {
    this.#authorize(instanceToken, WORKSPACES_APP_ID);
    this.#refStore.deleteWorkspace(workspaceIdHex);
  }

  async listDirectory(
    instanceToken: string,
    workspaceIdHex: string,
    parentEntryId?: string,
  ): Promise<{
    revision: number;
    rootEntryId: string;
    parent: PublicFileEntry;
    breadcrumbs: PublicFileEntry[];
    entries: PublicFileEntry[];
  }> {
    this.#authorize(instanceToken, WORKSPACES_APP_ID);
    const workspace = this.#refStore.getWorkspace(workspaceIdHex);
    const index = await loadCurrentEntryIndex(
      this.#repository,
      this.#refStore,
      workspace.refId,
    );
    const parentId = parentEntryId ?? index.rootEntryIdHex;
    const parent = index.get(parentId);
    if (!parent || parent.kind !== "directory") {
      throw new FileCapabilityError(
        "HANDLE_NOT_FOUND",
        "Workspace directory was not found.",
      );
    }
    return {
      revision: index.revision,
      rootEntryId: index.rootEntryIdHex,
      parent: publicEntry(parent),
      breadcrumbs: buildDirectoryBreadcrumbs(index, parent),
      entries: index.listChildren(parentId).map(publicEntry),
    };
  }

  #authorize(instanceToken: string, requiredAppId: string): void {
    const identity = this.#capabilities.authorizeInstance(instanceToken);
    if (identity.appId !== requiredAppId) {
      throw new FileCapabilityError(
        "PERMISSION_DENIED",
        `This operation is restricted to ${requiredAppId}.`,
      );
    }
  }
}

function publicEntry(entry: IndexedEntry): PublicFileEntry {
  return {
    entryId: entry.entryIdHex,
    name: entry.name,
    kind: entry.kind,
    ...(entry.content ? { size: entry.content.size } : {}),
    mtimeMs: entry.mtimeMs,
  };
}
