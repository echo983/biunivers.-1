import {
  loadEntryIndexAtHead,
  type EntryIndex,
} from "../files/entryIndex.js";
import type { ImmutableObjectRepository } from "../files/immutableObjectRepository.js";
import type {
  CommitWorkspaceRunResult,
  SqliteRefStore,
} from "../files/sqliteRefStore.js";
import {
  planCommitOperations,
  type CommitOperation,
} from "./commitOperationPlanner.js";
import {
  resolveTargetContent,
  type UpperContentMaterializer,
} from "./upperContentMaterializer.js";
import type { TargetTreeProjector } from "./targetTreeProjector.js";
import type {
  UpperScanLimits,
  UpperScanResult,
  UpperScanner,
} from "./upperScanner.js";
import type {
  WorkspaceCommitObjectBuilder,
  WorkspaceCommitObjects,
} from "./workspaceCommitObjectBuilder.js";

interface Scanner {
  scan(input: {
    runIdHex: string;
    upperPath: string;
    limits: UpperScanLimits;
  }): Promise<UpperScanResult>;
}

interface Projector {
  project(
    lower: EntryIndex,
    upper: UpperScanResult["entries"],
  ): ReturnType<TargetTreeProjector["project"]>;
}

interface Materializer {
  materialize(
    input: Parameters<UpperContentMaterializer["materialize"]>[0],
  ): ReturnType<UpperContentMaterializer["materialize"]>;
}

interface ObjectBuilder {
  build(
    input: Parameters<WorkspaceCommitObjectBuilder["build"]>[0],
  ): ReturnType<WorkspaceCommitObjectBuilder["build"]>;
}

export interface WorkspaceCommitResult extends CommitWorkspaceRunResult {
  changed: boolean;
  operationCount: number;
  objects?: WorkspaceCommitObjects;
}

export class WorkspaceCommitCoordinator {
  readonly #repository: ImmutableObjectRepository;
  readonly #refStore: SqliteRefStore;
  readonly #scanner: Scanner;
  readonly #projector: Projector;
  readonly #materializer: Materializer;
  readonly #builder: ObjectBuilder;
  readonly #limits: UpperScanLimits;
  readonly #now: () => number;

  constructor(options: {
    repository: ImmutableObjectRepository;
    refStore: SqliteRefStore;
    scanner: Pick<UpperScanner, "scan">;
    projector: Pick<TargetTreeProjector, "project">;
    materializer: Pick<UpperContentMaterializer, "materialize">;
    builder: Pick<WorkspaceCommitObjectBuilder, "build">;
    limits: UpperScanLimits;
    now?: () => number;
  }) {
    this.#repository = options.repository;
    this.#refStore = options.refStore;
    this.#scanner = options.scanner;
    this.#projector = options.projector;
    this.#materializer = options.materializer;
    this.#builder = options.builder;
    this.#limits = { ...options.limits };
    this.#now = options.now ?? Date.now;
  }

  async commit(input: {
    runIdHex: string;
    upperPath: string;
  }): Promise<WorkspaceCommitResult> {
    const run = this.#refStore.getWorkspaceRun(input.runIdHex);
    if (run.state !== "STOPPED") {
      throw new Error("Only a STOPPED Workspace Run can be committed.");
    }
    const workspace = this.#refStore.getWorkspace(run.workspaceIdHex);
    const ref = this.#refStore.getRef(workspace.refId);
    const startedAtMs = this.#timestamp();
    this.#refStore.transitionWorkspaceRun({
      runIdHex: run.runIdHex,
      expectedState: "STOPPED",
      newState: "COMMITTING",
      timestampMs: startedAtMs,
    });

    try {
      if (ref.headFidHex !== run.inputHeadFidHex) {
        throw new Error("Workspace Ref no longer matches the Run input Head.");
      }
      const [lower, scan] = await Promise.all([
        loadEntryIndexAtHead(
          this.#repository,
          run.inputHeadFidHex,
          ref.revision,
          ref.lineageIdHex,
        ),
        this.#scanner.scan({
          runIdHex: run.runIdHex,
          upperPath: input.upperPath,
          limits: this.#limits,
        }),
      ]);
      const projected = this.#projector.project(lower, scan.entries);
      const materialized = await this.#materializer.materialize({
        upperRoot: input.upperPath,
        scanEntries: scan.entries,
      });
      const target = resolveTargetContent(projected, materialized);
      const operations = planCommitOperations(lower, target);
      return await this.#publish(
        run.runIdHex,
        run.inputHeadFidHex,
        ref.revision,
        operations,
      );
    } catch (error) {
      await this.#failCommittingRun(run.runIdHex, error);
      throw error;
    }
  }

  async #publish(
    runIdHex: string,
    inputHeadFidHex: string,
    expectedRevision: number,
    operations: CommitOperation[],
  ): Promise<WorkspaceCommitResult> {
    if (operations.length === 0) {
      const result = this.#refStore.completeUnchangedWorkspaceRun({
        runIdHex,
        expectedHeadFidHex: inputHeadFidHex,
        expectedRevision,
        timestampMs: this.#timestamp(),
      });
      return { ...result, changed: false, operationCount: 0 };
    }
    const timestampMs = this.#timestamp();
    const objects = await this.#builder.build({
      baseHeadFidHex: inputHeadFidHex,
      expectedRevision,
      operations,
      timestampMs,
    });
    const result = this.#refStore.commitWorkspaceRun({
      runIdHex,
      expectedHeadFidHex: inputHeadFidHex,
      expectedRevision,
      newHeadFidHex: objects.headFidHex,
      newRevision: objects.revision,
      timestampMs,
    });
    return {
      ...result,
      changed: true,
      operationCount: operations.length,
      objects,
    };
  }

  async #failCommittingRun(runIdHex: string, cause: unknown): Promise<void> {
    const current = this.#refStore.getWorkspaceRun(runIdHex);
    if (current.state !== "COMMITTING") return;
    try {
      this.#refStore.transitionWorkspaceRun({
        runIdHex,
        expectedState: "COMMITTING",
        newState: "FAILED",
        errorCode: "COW_COMMIT_FAILED",
        timestampMs: this.#timestamp(),
      });
    } catch (transitionError) {
      throw new AggregateError(
        [cause, transitionError],
        "Workspace commit failed and its Run could not be finalized.",
        { cause: transitionError },
      );
    }
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Workspace commit timestamp is invalid.");
    }
    return value;
  }
}
