import { randomBytes } from "node:crypto";
import {
  loadCurrentEntryIndex,
  loadEntryIndexAtHead,
} from "../files/entryIndex.js";
import { FileSystemTransactions } from "../files/fileSystemTransactions.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import {
  RefStoreError,
  type SqliteRefStore,
} from "../files/sqliteRefStore.js";
import {
  planWorkspaceImport,
  type WorkspaceImportPlan,
} from "./workspaceImportPlanner.js";

export interface WorkspaceImportResult {
  revision: number;
  roots: WorkspaceImportPlan["roots"];
}

export class WorkspaceImportService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #transactions: FileSystemTransactions;
  readonly #randomId: () => Uint8Array;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    writerId: string;
    transactions?: FileSystemTransactions;
    randomId?: () => Uint8Array;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#transactions =
      options.transactions ??
      new FileSystemTransactions({
        repository: options.repository,
        refStore: options.refStore,
        refId: "main",
        writerId: options.writerId,
      });
    this.#randomId = options.randomId ?? (() => randomBytes(16));
  }

  async execute(input: {
    workspaceIdHex: string;
    selectedEntryIdsHex: string[];
    destinationEntryIdHex: string;
    workspaceRevision: number;
    mainRevision: number;
    conflictPolicy: "cancel" | "rename";
  }): Promise<WorkspaceImportResult> {
    if (
      !Number.isSafeInteger(input.workspaceRevision) ||
      input.workspaceRevision < 0 ||
      !Number.isSafeInteger(input.mainRevision) ||
      input.mainRevision < 0
    ) {
      throw new Error("Workspace import revision is invalid.");
    }
    const workspace = this.#refStore.getWorkspace(input.workspaceIdHex);
    if (workspace.activeWriteRunIdHex !== null) {
      throw new RefStoreError(
        "WORKSPACE_ACTIVE",
        "An active Workspace Run cannot be imported.",
      );
    }
    const workspaceRef = this.#refStore.getRef(workspace.refId);
    if (workspaceRef.revision !== input.workspaceRevision) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Workspace changed before import planning.",
      );
    }
    const [source, main] = await Promise.all([
      loadEntryIndexAtHead(
        this.#repository,
        workspaceRef.headFidHex,
        workspaceRef.revision,
        workspaceRef.lineageIdHex,
      ),
      loadCurrentEntryIndex(this.#repository, this.#refStore, "main"),
    ]);
    if (main.revision !== input.mainRevision) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Main changed before import planning.",
      );
    }
    const plan = planWorkspaceImport({
      source,
      main,
      selectedEntryIdsHex: input.selectedEntryIdsHex,
      destinationEntryIdHex: input.destinationEntryIdHex,
      conflictPolicy: input.conflictPolicy,
      randomId: this.#randomId,
    });
    const finalWorkspaceRef = this.#refStore.getRef(workspace.refId);
    if (
      finalWorkspaceRef.headFidHex !== workspaceRef.headFidHex ||
      finalWorkspaceRef.revision !== workspaceRef.revision ||
      finalWorkspaceRef.lineageIdHex !== workspaceRef.lineageIdHex
    ) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Workspace changed while import was being planned.",
      );
    }
    const published = await this.#transactions.applyBatch({
      operations: plan.operations,
      expectedRevision: input.mainRevision,
    });
    return { revision: published.ref.revision, roots: plan.roots };
  }
}
