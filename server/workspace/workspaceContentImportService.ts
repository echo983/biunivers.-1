import { loadEntryIndexAtHead } from "../files/entryIndex.js";
import { FileSystemTransactions } from "../files/fileSystemTransactions.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import { RefStoreError, type SqliteRefStore } from "../files/sqliteRefStore.js";
import { planWorkspaceContentImport, type WorkspaceContentImportPlan } from "./workspaceContentImportPlanner.js";

export class WorkspaceContentImportService {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #writerId: string;
  readonly #randomId?: () => Uint8Array;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    writerId: string;
    randomId?: () => Uint8Array;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#writerId = options.writerId;
    this.#randomId = options.randomId;
  }

  async execute(input: {
    workspaceIdHex: string;
    selectedEntryIdsHex: string[];
    destinationEntryIdHex: string;
    mainRevision: number;
    workspaceRevision: number;
  }): Promise<{ revision: number; roots: WorkspaceContentImportPlan["roots"] }> {
    if (![input.mainRevision, input.workspaceRevision].every((value) => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error("Workspace content import revision is invalid.");
    }
    const workspace = this.#refStore.getWorkspace(input.workspaceIdHex);
    assertWorkspaceWritable(this.#refStore, workspace.workspaceIdHex);
    const mainRef = this.#refStore.getRef("main");
    const workspaceRef = this.#refStore.getRef(workspace.refId);
    if (mainRef.revision !== input.mainRevision || workspaceRef.revision !== input.workspaceRevision) {
      throw new RefStoreError("REF_CONFLICT", "Main or Workspace changed before import planning.");
    }
    const [main, target] = await Promise.all([
      loadEntryIndexAtHead(this.#repository, mainRef.headFidHex, mainRef.revision, mainRef.lineageIdHex),
      loadEntryIndexAtHead(this.#repository, workspaceRef.headFidHex, workspaceRef.revision, workspaceRef.lineageIdHex),
    ]);
    const plan = planWorkspaceContentImport({
      main,
      workspace: target,
      selectedEntryIdsHex: input.selectedEntryIdsHex,
      destinationEntryIdHex: input.destinationEntryIdHex,
      ...(this.#randomId ? { randomId: this.#randomId } : {}),
    });
    assertWorkspaceWritable(this.#refStore, workspace.workspaceIdHex);
    const transactions = new FileSystemTransactions({
      repository: this.#repository,
      refStore: this.#refStore,
      refId: workspace.refId,
      writerId: this.#writerId,
    });
    const published = await transactions.applyBatch({
      operations: plan.operations,
      expectedRevision: input.workspaceRevision,
      guardRef: {
        refId: "main",
        expectedHeadFidHex: mainRef.headFidHex,
        expectedRevision: mainRef.revision,
      },
      writableWorkspaceIdHex: workspace.workspaceIdHex,
    });
    return { revision: published.ref.revision, roots: plan.roots };
  }
}

function assertWorkspaceWritable(refStore: SqliteRefStore, workspaceIdHex: string): void {
  const workspace = refStore.getWorkspace(workspaceIdHex);
  if (workspace.activeWriteRunIdHex !== null || refStore.listWorkspaceRuns(workspaceIdHex).some((run) => run.state === "FAILED" || run.state === "CONFLICT")) {
    throw new RefStoreError("WORKSPACE_ACTIVE", "Workspace is running or has unresolved changes.");
  }
}
