import { randomUUID } from "node:crypto";
import { access, link, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const FID_HEX_PATTERN = /^[0-9a-f]{32}$/;
const ID_HEX_PATTERN = /^[0-9a-f]{32}$/;

export interface FilesystemRef {
  refId: string;
  lineageIdHex: string;
  headFidHex: string;
  revision: number;
  updatedAtMs: number;
}

export type CreateRefInput = FilesystemRef;

export interface RefCasInput {
  refId: string;
  expectedHeadFidHex: string;
  expectedRevision: number;
  newHeadFidHex: string;
  newRevision: number;
  updatedAtMs: number;
}

export interface FilesystemSnapshot {
  snapshotIdHex: string;
  refId: string;
  name: string;
  headFidHex: string;
  revision: number;
  createdAtMs: number;
  pinned: boolean;
}

export type WorkspaceState = "READY" | "DELETING";
export type WorkspaceRetention = "TEMPORARY" | "KEPT";

export interface WorkspaceRecord {
  workspaceIdHex: string;
  refId: string;
  name: string;
  sourceRefId: string;
  sourceHeadFidHex: string;
  baselineHeadFidHex: string;
  state: WorkspaceState;
  retention: WorkspaceRetention;
  activeWriteRunIdHex: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface CreateWorkspaceInput extends WorkspaceRecord {
  state: "READY";
  activeWriteRunIdHex: null;
  ref: CreateRefInput;
}

export type WorkspaceRunState =
  | "PREPARING"
  | "RUNNING"
  | "STOPPED"
  | "COMMITTING"
  | "COMMITTED"
  | "CONFLICT"
  | "FAILED"
  | "DISCARDED";

export interface WorkspaceRunRecord {
  runIdHex: string;
  workspaceIdHex: string;
  executorId: string;
  inputHeadFidHex: string;
  outputHeadFidHex: string | null;
  state: WorkspaceRunState;
  runtimeIdentity: string | null;
  errorCode: string | null;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export interface CreateWorkspaceRunInput {
  runIdHex: string;
  workspaceIdHex: string;
  executorId: string;
  inputHeadFidHex: string;
  createdAtMs: number;
}

export interface TransitionWorkspaceRunInput {
  runIdHex: string;
  expectedState: WorkspaceRunState;
  newState: Exclude<WorkspaceRunState, "COMMITTED">;
  timestampMs: number;
  runtimeIdentity?: string;
  outputHeadFidHex?: string;
  errorCode?: string;
}

export interface CommitWorkspaceRunInput {
  runIdHex: string;
  expectedHeadFidHex: string;
  expectedRevision: number;
  newHeadFidHex: string;
  newRevision: number;
  timestampMs: number;
}

export interface CommitWorkspaceRunResult {
  outcome: "committed" | "conflict";
  run: WorkspaceRunRecord;
  ref: FilesystemRef;
}

export type RefStoreErrorCode =
  | "REFSTORE_MISSING"
  | "REFSTORE_CORRUPT"
  | "REF_ALREADY_EXISTS"
  | "REF_NOT_FOUND"
  | "REF_CONFLICT"
  | "SNAPSHOT_ALREADY_EXISTS"
  | "WORKSPACE_ALREADY_EXISTS"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_ACTIVE"
  | "RUN_ALREADY_EXISTS"
  | "RUN_NOT_FOUND"
  | "RUN_STATE_CONFLICT"
  | "INVALID_REF_VALUE";

export class RefStoreError extends Error {
  constructor(
    public readonly code: RefStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RefStoreError";
  }
}

export class SqliteRefStore {
  readonly #database: Database.Database;
  readonly databasePath: string;

  private constructor(databasePath: string, database: Database.Database) {
    this.databasePath = databasePath;
    this.#database = database;
  }

  static async initialize(databasePath: string): Promise<SqliteRefStore> {
    await mkdir(dirname(databasePath), { recursive: true });
    if (await pathExists(databasePath)) {
      throw new RefStoreError(
        "REF_ALREADY_EXISTS",
        "RefStore already exists; use openExisting instead of reinitializing it.",
      );
    }
    const database = new Database(databasePath);
    try {
      configureDatabase(database);
      createSchema(database);
      return new SqliteRefStore(databasePath, database);
    } catch (error) {
      database.close();
      throw error;
    }
  }

  static async openExisting(databasePath: string): Promise<SqliteRefStore> {
    if (!(await pathExists(databasePath))) {
      throw new RefStoreError(
        "REFSTORE_MISSING",
        "RefStore is missing; restore it or run an explicit first-time initialization.",
      );
    }

    let database: Database.Database;
    try {
      database = new Database(databasePath);
    } catch (error) {
      throw corrupt(error);
    }
    try {
      configureDatabase(database);
      migrateSchema(database);
      verifyDatabase(database);
      return new SqliteRefStore(databasePath, database);
    } catch (error) {
      database.close();
      if (error instanceof RefStoreError) {
        throw error;
      }
      throw corrupt(error);
    }
  }

  static async initializeWithRef(
    databasePath: string,
    initialRef: CreateRefInput,
  ): Promise<SqliteRefStore> {
    validateRef(initialRef);
    await mkdir(dirname(databasePath), { recursive: true });
    if (await pathExists(databasePath)) {
      throw new RefStoreError(
        "REF_ALREADY_EXISTS",
        "RefStore already exists; genesis initialization is create-only.",
      );
    }

    const temporaryPath = join(
      dirname(databasePath),
      `.${randomUUID()}.sqlite-genesis`,
    );
    let database: Database.Database | undefined;
    try {
      database = new Database(temporaryPath);
      configureDatabase(database);
      createSchema(database);
      const temporaryStore = new SqliteRefStore(temporaryPath, database);
      temporaryStore.createRef(initialRef);
      database.pragma("wal_checkpoint(TRUNCATE)");
      database.close();
      database = undefined;

      try {
        await link(temporaryPath, databasePath);
      } catch (error) {
        if (isNodeError(error, "EEXIST")) {
          throw new RefStoreError(
            "REF_ALREADY_EXISTS",
            "Another process initialized the RefStore first.",
            { cause: error },
          );
        }
        throw error;
      }
      return await SqliteRefStore.openExisting(databasePath);
    } finally {
      if (database?.open) {
        database.close();
      }
      await Promise.all([
        rm(temporaryPath, { force: true }),
        rm(`${temporaryPath}-wal`, { force: true }),
        rm(`${temporaryPath}-shm`, { force: true }),
      ]);
    }
  }

  close(): void {
    this.#database.close();
  }

  createRef(input: CreateRefInput): FilesystemRef {
    validateRef(input);
    try {
      this.#database
        .prepare(
          `INSERT INTO filesystem_refs
             (ref_id, lineage_id, head_fid, revision, updated_at_ms)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.refId,
          fromHex(input.lineageIdHex),
          fromHex(input.headFidHex),
          input.revision,
          input.updatedAtMs,
        );
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new RefStoreError(
          "REF_ALREADY_EXISTS",
          `Ref ${input.refId} already exists.`,
          { cause: error },
        );
      }
      throw error;
    }
    return { ...input };
  }

  listRefs(): FilesystemRef[] {
    const rows = this.#database
      .prepare(
        `SELECT ref_id, lineage_id, head_fid, revision, updated_at_ms
         FROM filesystem_refs
         ORDER BY ref_id`,
      )
      .all() as RefRow[];
    return rows.map(mapRef);
  }

  getRef(refId: string): FilesystemRef {
    validateRefId(refId);
    const row = this.#database
      .prepare(
        `SELECT ref_id, lineage_id, head_fid, revision, updated_at_ms
         FROM filesystem_refs
         WHERE ref_id = ?`,
      )
      .get(refId) as RefRow | undefined;
    if (!row) {
      throw new RefStoreError("REF_NOT_FOUND", `Ref ${refId} was not found.`);
    }
    return mapRef(row);
  }

  compareAndSwap(input: RefCasInput): FilesystemRef {
    validateRefId(input.refId);
    validateFid(input.expectedHeadFidHex);
    validateFid(input.newHeadFidHex);
    validateSafeInteger(input.expectedRevision, "expected revision");
    validateSafeInteger(input.newRevision, "new revision");
    validateTimestamp(input.updatedAtMs);
    if (input.newRevision !== input.expectedRevision + 1) {
      throw new RefStoreError(
        "INVALID_REF_VALUE",
        "A Ref CAS must advance revision by exactly one.",
      );
    }

    const transaction = this.#database.transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE filesystem_refs
           SET head_fid = ?, revision = ?, updated_at_ms = ?
           WHERE ref_id = ? AND head_fid = ? AND revision = ?`,
        )
        .run(
          fromHex(input.newHeadFidHex),
          input.newRevision,
          input.updatedAtMs,
          input.refId,
          fromHex(input.expectedHeadFidHex),
          input.expectedRevision,
        );
      if (result.changes !== 1) {
        throw new RefStoreError(
          "REF_CONFLICT",
          `Ref ${input.refId} changed before it could be published.`,
        );
      }
      return this.getRef(input.refId);
    });
    return transaction();
  }

  createSnapshot(
    input: Omit<FilesystemSnapshot, "snapshotIdHex"> & {
      snapshotIdHex?: string;
    },
  ): FilesystemSnapshot {
    validateRefId(input.refId);
    validateSnapshotName(input.name);
    validateFid(input.headFidHex);
    validateSafeInteger(input.revision, "snapshot revision");
    validateTimestamp(input.createdAtMs);
    const current = this.getRef(input.refId);
    if (
      current.headFidHex !== input.headFidHex ||
      current.revision !== input.revision
    ) {
      throw new RefStoreError(
        "REF_CONFLICT",
        "Snapshot target is not the current value of its Ref.",
      );
    }
    const snapshotIdHex =
      input.snapshotIdHex ?? randomUUID().replaceAll("-", "");
    validateId(snapshotIdHex, "snapshot ID");

    try {
      this.#database
        .prepare(
          `INSERT INTO filesystem_snapshots
             (snapshot_id, ref_id, name, head_fid, revision, created_at_ms, pinned)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          fromHex(snapshotIdHex),
          input.refId,
          input.name,
          fromHex(input.headFidHex),
          input.revision,
          input.createdAtMs,
          input.pinned ? 1 : 0,
        );
    } catch (error) {
      if (isSqliteConstraint(error)) {
        throw new RefStoreError(
          "SNAPSHOT_ALREADY_EXISTS",
          "Snapshot ID or name already exists for this Ref.",
          { cause: error },
        );
      }
      throw error;
    }
    return { ...input, snapshotIdHex };
  }

  listSnapshots(refId: string): FilesystemSnapshot[] {
    validateRefId(refId);
    const rows = this.#database
      .prepare(
        `SELECT snapshot_id, ref_id, name, head_fid, revision, created_at_ms, pinned
         FROM filesystem_snapshots
         WHERE ref_id = ?
         ORDER BY created_at_ms, snapshot_id`,
      )
      .all(refId) as SnapshotRow[];
    return rows.map((row) => ({
      snapshotIdHex: toHex(row.snapshot_id),
      refId: row.ref_id,
      name: row.name,
      headFidHex: toHex(row.head_fid),
      revision: row.revision,
      createdAtMs: row.created_at_ms,
      pinned: row.pinned === 1,
    }));
  }

  listProtectedHeadFids(refId: string): string[] {
    validateRefId(refId);
    return this.#database.transaction(() => {
      const current = this.getRef(refId);
      return [
        current.headFidHex,
        ...this.listSnapshots(refId).map((snapshot) => snapshot.headFidHex),
      ];
    })();
  }

  createWorkspace(input: CreateWorkspaceInput): WorkspaceRecord {
    validateWorkspace(input);
    validateRef(input.ref);
    if (input.refId !== input.ref.refId) {
      throw invalid("Workspace Ref ID does not match its Ref.");
    }
    if (input.refId !== `ws-${input.workspaceIdHex}`) {
      throw invalid("Workspace Ref ID is not derived from its Workspace ID.");
    }
    if (input.baselineHeadFidHex !== input.ref.headFidHex) {
      throw invalid("Workspace baseline Head does not match its initial Ref.");
    }
    const transaction = this.#database.transaction(() => {
      const source = this.getRef(input.sourceRefId);
      if (source.headFidHex !== input.sourceHeadFidHex) {
        throw new RefStoreError(
          "REF_CONFLICT",
          "Workspace source Ref changed before publication.",
        );
      }
      this.createRef(input.ref);
      try {
        this.#database
          .prepare(
            `INSERT INTO workspace_records (
               workspace_id, ref_id, name, source_ref_id, source_head_fid,
               baseline_head_fid, state, retention, active_write_run_id,
               created_at_ms, updated_at_ms
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
          )
          .run(
            fromHex(input.workspaceIdHex),
            input.refId,
            input.name,
            input.sourceRefId,
            fromHex(input.sourceHeadFidHex),
            fromHex(input.baselineHeadFidHex),
            input.state,
            input.retention,
            input.createdAtMs,
            input.updatedAtMs,
          );
      } catch (error) {
        if (isSqliteConstraint(error)) {
          throw new RefStoreError(
            "WORKSPACE_ALREADY_EXISTS",
            "Workspace ID or Ref already belongs to a Workspace.",
            { cause: error },
          );
        }
        throw error;
      }
      return this.getWorkspace(input.workspaceIdHex);
    });
    return transaction();
  }

  getWorkspace(workspaceIdHex: string): WorkspaceRecord {
    validateId(workspaceIdHex, "workspace ID");
    const row = this.#database
      .prepare(
        `SELECT workspace_id, ref_id, name, source_ref_id, source_head_fid,
                baseline_head_fid, state, retention, active_write_run_id,
                created_at_ms, updated_at_ms
         FROM workspace_records
         WHERE workspace_id = ?`,
      )
      .get(fromHex(workspaceIdHex)) as WorkspaceRow | undefined;
    if (!row) {
      throw new RefStoreError(
        "WORKSPACE_NOT_FOUND",
        "Workspace was not found.",
      );
    }
    return mapWorkspace(row);
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT workspace_id, ref_id, name, source_ref_id, source_head_fid,
                baseline_head_fid, state, retention, active_write_run_id,
                created_at_ms, updated_at_ms
         FROM workspace_records
         ORDER BY created_at_ms, workspace_id`,
      )
      .all() as WorkspaceRow[];
    return rows.map(mapWorkspace);
  }

  deleteWorkspace(workspaceIdHex: string): void {
    validateId(workspaceIdHex, "workspace ID");
    this.#database.transaction(() => {
      const workspace = this.getWorkspace(workspaceIdHex);
      if (workspace.activeWriteRunIdHex !== null) {
        throw new RefStoreError(
          "WORKSPACE_ACTIVE",
          "Workspace has an active write Run.",
        );
      }
      this.#database
        .prepare("DELETE FROM workspace_runs WHERE workspace_id = ?")
        .run(fromHex(workspaceIdHex));
      this.#database
        .prepare("DELETE FROM filesystem_snapshots WHERE ref_id = ?")
        .run(workspace.refId);
      this.#database
        .prepare("DELETE FROM workspace_records WHERE workspace_id = ?")
        .run(fromHex(workspaceIdHex));
      const deleted = this.#database
        .prepare("DELETE FROM filesystem_refs WHERE ref_id = ?")
        .run(workspace.refId);
      if (deleted.changes !== 1) {
        throw new RefStoreError(
          "REFSTORE_CORRUPT",
          "Workspace Ref disappeared during deletion.",
        );
      }
    })();
  }

  createWorkspaceRun(input: CreateWorkspaceRunInput): WorkspaceRunRecord {
    validateId(input.runIdHex, "Run ID");
    validateId(input.workspaceIdHex, "workspace ID");
    validateExecutorId(input.executorId);
    validateFid(input.inputHeadFidHex);
    validateTimestamp(input.createdAtMs);
    return this.#database.transaction(() => {
      const workspace = this.getWorkspace(input.workspaceIdHex);
      if (workspace.state !== "READY" || workspace.activeWriteRunIdHex) {
        throw new RefStoreError(
          "WORKSPACE_ACTIVE",
          "Workspace is not available for a new write Run.",
        );
      }
      const ref = this.getRef(workspace.refId);
      if (ref.headFidHex !== input.inputHeadFidHex) {
        throw new RefStoreError(
          "REF_CONFLICT",
          "Run input Head is not the current Workspace Ref.",
        );
      }
      try {
        this.#database
          .prepare(
            `INSERT INTO workspace_runs (
               run_id, workspace_id, executor_id, input_head_fid,
               output_head_fid, state, runtime_identity, error_code,
               created_at_ms, started_at_ms, finished_at_ms
             ) VALUES (?, ?, ?, ?, NULL, 'PREPARING', NULL, NULL, ?, NULL, NULL)`,
          )
          .run(
            fromHex(input.runIdHex),
            fromHex(input.workspaceIdHex),
            input.executorId,
            fromHex(input.inputHeadFidHex),
            input.createdAtMs,
          );
      } catch (error) {
        if (isSqliteConstraint(error)) {
          throw new RefStoreError(
            "RUN_ALREADY_EXISTS",
            "Run ID already exists.",
            { cause: error },
          );
        }
        throw error;
      }
      const leased = this.#database
        .prepare(
          `UPDATE workspace_records
           SET active_write_run_id = ?, updated_at_ms = ?
           WHERE workspace_id = ? AND active_write_run_id IS NULL`,
        )
        .run(
          fromHex(input.runIdHex),
          input.createdAtMs,
          fromHex(input.workspaceIdHex),
        );
      if (leased.changes !== 1) {
        throw new RefStoreError(
          "WORKSPACE_ACTIVE",
          "Workspace write lease was acquired concurrently.",
        );
      }
      return this.getWorkspaceRun(input.runIdHex);
    })();
  }

  getWorkspaceRun(runIdHex: string): WorkspaceRunRecord {
    validateId(runIdHex, "Run ID");
    const row = this.#database
      .prepare(
        `SELECT run_id, workspace_id, executor_id, input_head_fid,
                output_head_fid, state, runtime_identity, error_code,
                created_at_ms, started_at_ms, finished_at_ms
         FROM workspace_runs
         WHERE run_id = ?`,
      )
      .get(fromHex(runIdHex)) as WorkspaceRunRow | undefined;
    if (!row) {
      throw new RefStoreError("RUN_NOT_FOUND", "Workspace Run was not found.");
    }
    return mapWorkspaceRun(row);
  }

  listWorkspaceRuns(workspaceIdHex: string): WorkspaceRunRecord[] {
    validateId(workspaceIdHex, "workspace ID");
    this.getWorkspace(workspaceIdHex);
    const rows = this.#database
      .prepare(
        `SELECT run_id, workspace_id, executor_id, input_head_fid,
                output_head_fid, state, runtime_identity, error_code,
                created_at_ms, started_at_ms, finished_at_ms
         FROM workspace_runs
         WHERE workspace_id = ?
         ORDER BY created_at_ms, run_id`,
      )
      .all(fromHex(workspaceIdHex)) as WorkspaceRunRow[];
    return rows.map(mapWorkspaceRun);
  }

  transitionWorkspaceRun(
    input: TransitionWorkspaceRunInput,
  ): WorkspaceRunRecord {
    validateId(input.runIdHex, "Run ID");
    validateTimestamp(input.timestampMs);
    validateRunTransitionInput(input);
    return this.#database.transaction(() => {
      const current = this.getWorkspaceRun(input.runIdHex);
      if (
        input.timestampMs < current.createdAtMs ||
        (current.startedAtMs !== null &&
          input.timestampMs < current.startedAtMs)
      ) {
        throw invalid("Run transition timestamp moves backwards.");
      }
      if (current.state !== input.expectedState) {
        throw new RefStoreError(
          "RUN_STATE_CONFLICT",
          `Run is ${current.state}, not ${input.expectedState}.`,
        );
      }
      if (!isAllowedRunTransition(current.state, input.newState)) {
        throw invalid(
          `Run transition ${current.state} → ${input.newState} is not allowed.`,
        );
      }
      const workspace = this.getWorkspace(current.workspaceIdHex);
      if (workspace.activeWriteRunIdHex !== current.runIdHex) {
        throw new RefStoreError(
          "RUN_STATE_CONFLICT",
          "Run no longer owns the Workspace write lease.",
        );
      }
      const terminal = isTerminalRunState(input.newState);
      const result = this.#database
        .prepare(
          `UPDATE workspace_runs
           SET state = ?,
               runtime_identity = COALESCE(?, runtime_identity),
               output_head_fid = COALESCE(?, output_head_fid),
               error_code = ?,
               started_at_ms = CASE
                 WHEN ? = 'RUNNING' THEN ? ELSE started_at_ms END,
               finished_at_ms = CASE
                 WHEN ? = 1 THEN ? ELSE finished_at_ms END
           WHERE run_id = ? AND state = ?`,
        )
        .run(
          input.newState,
          input.runtimeIdentity ?? null,
          input.outputHeadFidHex
            ? fromHex(input.outputHeadFidHex)
            : null,
          input.errorCode ?? null,
          input.newState,
          input.timestampMs,
          terminal ? 1 : 0,
          input.timestampMs,
          fromHex(input.runIdHex),
          input.expectedState,
        );
      if (result.changes !== 1) {
        throw new RefStoreError(
          "RUN_STATE_CONFLICT",
          "Run changed before its transition was published.",
        );
      }
      if (terminal) {
        const released = this.#database
          .prepare(
            `UPDATE workspace_records
             SET active_write_run_id = NULL, updated_at_ms = ?
             WHERE workspace_id = ? AND active_write_run_id = ?`,
          )
          .run(
            input.timestampMs,
            fromHex(current.workspaceIdHex),
            fromHex(current.runIdHex),
          );
        if (released.changes !== 1) {
          throw new RefStoreError(
            "RUN_STATE_CONFLICT",
            "Workspace write lease could not be released.",
          );
        }
      }
      return this.getWorkspaceRun(input.runIdHex);
    })();
  }

  commitWorkspaceRun(
    input: CommitWorkspaceRunInput,
  ): CommitWorkspaceRunResult {
    validateId(input.runIdHex, "Run ID");
    validateFid(input.expectedHeadFidHex);
    validateFid(input.newHeadFidHex);
    validateSafeInteger(input.expectedRevision, "expected revision");
    validateSafeInteger(input.newRevision, "new revision");
    validateTimestamp(input.timestampMs);
    if (input.newRevision !== input.expectedRevision + 1) {
      throw invalid("A committed Run must advance revision by exactly one.");
    }
    return this.#database.transaction(() => {
      const run = this.getWorkspaceRun(input.runIdHex);
      if (run.state !== "COMMITTING") {
        throw new RefStoreError(
          "RUN_STATE_CONFLICT",
          `Run is ${run.state}, not COMMITTING.`,
        );
      }
      if (
        run.inputHeadFidHex !== input.expectedHeadFidHex ||
        input.timestampMs < run.createdAtMs ||
        (run.startedAtMs !== null && input.timestampMs < run.startedAtMs)
      ) {
        throw invalid("Run commit input does not match its fixed input Head.");
      }
      const workspace = this.getWorkspace(run.workspaceIdHex);
      if (workspace.activeWriteRunIdHex !== run.runIdHex) {
        throw new RefStoreError(
          "RUN_STATE_CONFLICT",
          "Run no longer owns the Workspace write lease.",
        );
      }
      const updated = this.#database
        .prepare(
          `UPDATE filesystem_refs
           SET head_fid = ?, revision = ?, updated_at_ms = ?
           WHERE ref_id = ? AND head_fid = ? AND revision = ?`,
        )
        .run(
          fromHex(input.newHeadFidHex),
          input.newRevision,
          input.timestampMs,
          workspace.refId,
          fromHex(input.expectedHeadFidHex),
          input.expectedRevision,
        );
      const committed = updated.changes === 1;
      const state: WorkspaceRunState = committed ? "COMMITTED" : "CONFLICT";
      this.#database
        .prepare(
          `UPDATE workspace_runs
           SET state = ?, output_head_fid = ?, error_code = ?,
               finished_at_ms = ?
           WHERE run_id = ? AND state = 'COMMITTING'`,
        )
        .run(
          state,
          fromHex(input.newHeadFidHex),
          committed ? null : "REF_CONFLICT",
          input.timestampMs,
          fromHex(input.runIdHex),
        );
      const released = this.#database
        .prepare(
          `UPDATE workspace_records
           SET active_write_run_id = NULL, updated_at_ms = ?
           WHERE workspace_id = ? AND active_write_run_id = ?`,
        )
        .run(
          input.timestampMs,
          fromHex(run.workspaceIdHex),
          fromHex(run.runIdHex),
        );
      if (released.changes !== 1) {
        throw new RefStoreError(
          "RUN_STATE_CONFLICT",
          "Workspace write lease could not be released.",
        );
      }
      const outcome: CommitWorkspaceRunResult["outcome"] = committed
        ? "committed"
        : "conflict";
      return {
        outcome,
        run: this.getWorkspaceRun(run.runIdHex),
        ref: this.getRef(workspace.refId),
      };
    })();
  }

  async backupTo(destinationPath: string): Promise<void> {
    await mkdir(dirname(destinationPath), { recursive: true });
    const temporaryPath = join(
      dirname(destinationPath),
      `.${randomUUID()}.sqlite-backup`,
    );
    try {
      await this.#database.backup(temporaryPath);
      const backup = new Database(temporaryPath, { readonly: true });
      try {
        verifyDatabase(backup);
      } finally {
        backup.close();
      }
      await rename(temporaryPath, destinationPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}

interface RefRow {
  ref_id: string;
  lineage_id: Buffer;
  head_fid: Buffer;
  revision: number;
  updated_at_ms: number;
}

interface SnapshotRow {
  snapshot_id: Buffer;
  ref_id: string;
  name: string;
  head_fid: Buffer;
  revision: number;
  created_at_ms: number;
  pinned: number;
}

interface WorkspaceRow {
  workspace_id: Buffer;
  ref_id: string;
  name: string;
  source_ref_id: string;
  source_head_fid: Buffer;
  baseline_head_fid: Buffer;
  state: WorkspaceState;
  retention: WorkspaceRetention;
  active_write_run_id: Buffer | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface WorkspaceRunRow {
  run_id: Buffer;
  workspace_id: Buffer;
  executor_id: string;
  input_head_fid: Buffer;
  output_head_fid: Buffer | null;
  state: WorkspaceRunState;
  runtime_identity: string | null;
  error_code: string | null;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

function configureDatabase(database: Database.Database): void {
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
}

function createSchema(database: Database.Database): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE filesystem_refs (
      ref_id TEXT PRIMARY KEY,
      lineage_id BLOB NOT NULL CHECK(length(lineage_id) = 16),
      head_fid BLOB NOT NULL CHECK(length(head_fid) = 16),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
    ) STRICT;
    CREATE TABLE filesystem_snapshots (
      snapshot_id BLOB PRIMARY KEY CHECK(length(snapshot_id) = 16),
      ref_id TEXT NOT NULL REFERENCES filesystem_refs(ref_id),
      name TEXT NOT NULL,
      head_fid BLOB NOT NULL CHECK(length(head_fid) = 16),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      pinned INTEGER NOT NULL CHECK(pinned IN (0, 1)),
      UNIQUE(ref_id, name)
    ) STRICT;
    ${workspaceSchemaSql()}
    CREATE TABLE file_service_meta (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL
    ) STRICT;
    INSERT INTO file_service_meta(key, value)
    VALUES ('schema_version', X'00000002');
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
}

function migrateSchema(database: Database.Database): void {
  const version = database.pragma("user_version", { simple: true });
  if (version === SCHEMA_VERSION) {
    return;
  }
  if (version !== LEGACY_SCHEMA_VERSION) {
    throw new RefStoreError(
      "REFSTORE_CORRUPT",
      `Unsupported RefStore schema version: ${String(version)}.`,
    );
  }
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      ${workspaceSchemaSql()}
      UPDATE file_service_meta
      SET value = X'00000002'
      WHERE key = 'schema_version';
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `);
  } catch (error) {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
}

function workspaceSchemaSql(): string {
  return `
    CREATE TABLE workspace_records (
      workspace_id BLOB PRIMARY KEY CHECK(length(workspace_id) = 16),
      ref_id TEXT UNIQUE NOT NULL
        REFERENCES filesystem_refs(ref_id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      source_ref_id TEXT NOT NULL,
      source_head_fid BLOB NOT NULL CHECK(length(source_head_fid) = 16),
      baseline_head_fid BLOB NOT NULL CHECK(length(baseline_head_fid) = 16),
      state TEXT NOT NULL CHECK(state IN ('READY', 'DELETING')),
      retention TEXT NOT NULL CHECK(retention IN ('TEMPORARY', 'KEPT')),
      active_write_run_id BLOB,
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
      FOREIGN KEY(active_write_run_id) REFERENCES workspace_runs(run_id)
    ) STRICT;
    CREATE TABLE workspace_runs (
      run_id BLOB PRIMARY KEY CHECK(length(run_id) = 16),
      workspace_id BLOB NOT NULL
        REFERENCES workspace_records(workspace_id) ON DELETE RESTRICT,
      executor_id TEXT NOT NULL,
      input_head_fid BLOB NOT NULL CHECK(length(input_head_fid) = 16),
      output_head_fid BLOB
        CHECK(output_head_fid IS NULL OR length(output_head_fid) = 16),
      state TEXT NOT NULL CHECK(state IN (
        'PREPARING', 'RUNNING', 'STOPPED', 'COMMITTING',
        'COMMITTED', 'CONFLICT', 'FAILED', 'DISCARDED'
      )),
      runtime_identity TEXT,
      error_code TEXT,
      created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
      started_at_ms INTEGER CHECK(started_at_ms IS NULL OR started_at_ms >= 0),
      finished_at_ms INTEGER CHECK(finished_at_ms IS NULL OR finished_at_ms >= 0)
    ) STRICT;
    CREATE UNIQUE INDEX workspace_active_write_run
      ON workspace_records(active_write_run_id)
      WHERE active_write_run_id IS NOT NULL;
  `;
}

function verifyDatabase(database: Database.Database): void {
  const integrity = database.pragma("quick_check", { simple: true });
  if (integrity !== "ok") {
    throw new RefStoreError(
      "REFSTORE_CORRUPT",
      "RefStore failed SQLite integrity validation.",
    );
  }
  const version = database.pragma("user_version", { simple: true });
  if (version !== SCHEMA_VERSION) {
    throw new RefStoreError(
      "REFSTORE_CORRUPT",
      `Unsupported RefStore schema version: ${String(version)}.`,
    );
  }
  const requiredTables = [
    "filesystem_refs",
    "filesystem_snapshots",
    "workspace_records",
    "workspace_runs",
    "file_service_meta",
  ];
  const placeholders = requiredTables.map(() => "?").join(", ");
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (${placeholders})`,
    )
    .all(...requiredTables) as Array<{ name: string }>;
  if (new Set(rows.map((row) => row.name)).size !== requiredTables.length) {
    throw new RefStoreError(
      "REFSTORE_CORRUPT",
      "RefStore schema is incomplete.",
    );
  }
}

function mapRef(row: RefRow): FilesystemRef {
  return {
    refId: row.ref_id,
    lineageIdHex: toHex(row.lineage_id),
    headFidHex: toHex(row.head_fid),
    revision: row.revision,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    workspaceIdHex: toHex(row.workspace_id),
    refId: row.ref_id,
    name: row.name,
    sourceRefId: row.source_ref_id,
    sourceHeadFidHex: toHex(row.source_head_fid),
    baselineHeadFidHex: toHex(row.baseline_head_fid),
    state: row.state,
    retention: row.retention,
    activeWriteRunIdHex:
      row.active_write_run_id === null
        ? null
        : toHex(row.active_write_run_id),
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function mapWorkspaceRun(row: WorkspaceRunRow): WorkspaceRunRecord {
  return {
    runIdHex: toHex(row.run_id),
    workspaceIdHex: toHex(row.workspace_id),
    executorId: row.executor_id,
    inputHeadFidHex: toHex(row.input_head_fid),
    outputHeadFidHex:
      row.output_head_fid === null ? null : toHex(row.output_head_fid),
    state: row.state,
    runtimeIdentity: row.runtime_identity,
    errorCode: row.error_code,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
  };
}

function validateRef(input: CreateRefInput): void {
  validateRefId(input.refId);
  validateId(input.lineageIdHex, "lineage ID");
  validateFid(input.headFidHex);
  validateSafeInteger(input.revision, "revision");
  validateTimestamp(input.updatedAtMs);
}

function validateRefId(refId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(refId)) {
    throw new RefStoreError("INVALID_REF_VALUE", "Ref ID is invalid.");
  }
}

function validateSnapshotName(name: string): void {
  if (
    name.length === 0 ||
    Buffer.byteLength(name) > 255 ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new RefStoreError("INVALID_REF_VALUE", "Snapshot name is invalid.");
  }
}

function validateWorkspace(input: WorkspaceRecord): void {
  validateId(input.workspaceIdHex, "workspace ID");
  validateRefId(input.refId);
  validateWorkspaceName(input.name);
  validateRefId(input.sourceRefId);
  validateFid(input.sourceHeadFidHex);
  validateFid(input.baselineHeadFidHex);
  if (input.state !== "READY" && input.state !== "DELETING") {
    throw invalid("Workspace state is invalid.");
  }
  if (input.retention !== "TEMPORARY" && input.retention !== "KEPT") {
    throw invalid("Workspace retention is invalid.");
  }
  if (input.activeWriteRunIdHex !== null) {
    validateId(input.activeWriteRunIdHex, "active write Run ID");
  }
  validateTimestamp(input.createdAtMs);
  validateTimestamp(input.updatedAtMs);
  if (input.updatedAtMs < input.createdAtMs) {
    throw invalid("Workspace update timestamp predates its creation.");
  }
}

function validateWorkspaceName(name: string): void {
  if (
    name !== name.normalize("NFC") ||
    name.trim().length === 0 ||
    Buffer.byteLength(name) > 255 ||
    [...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw invalid("Workspace name is invalid.");
  }
}

function validateExecutorId(executorId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(executorId)) {
    throw invalid("Executor ID is invalid.");
  }
}

function validateRunTransitionInput(
  input: TransitionWorkspaceRunInput,
): void {
  if (input.runtimeIdentity !== undefined) {
    if (
      input.newState !== "RUNNING" ||
      input.runtimeIdentity.length === 0 ||
      Buffer.byteLength(input.runtimeIdentity) > 255
    ) {
      throw invalid("Runtime identity is invalid for this transition.");
    }
  } else if (input.newState === "RUNNING") {
    throw invalid("RUNNING requires a Runtime identity.");
  }
  if (input.outputHeadFidHex !== undefined) {
    validateFid(input.outputHeadFidHex);
    if (input.newState !== "CONFLICT") {
      throw invalid("Output Head is only accepted for a conflicting commit.");
    }
  }
  if (input.errorCode !== undefined) {
    if (
      (input.newState !== "FAILED" && input.newState !== "CONFLICT") ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(input.errorCode)
    ) {
      throw invalid("Run error code is invalid for this transition.");
    }
  } else if (input.newState === "FAILED") {
    throw invalid("FAILED requires an error code.");
  }
}

function isAllowedRunTransition(
  current: WorkspaceRunState,
  next: WorkspaceRunState,
): boolean {
  const transitions: Record<WorkspaceRunState, readonly WorkspaceRunState[]> = {
    PREPARING: ["RUNNING", "FAILED", "DISCARDED"],
    RUNNING: ["STOPPED", "FAILED"],
    STOPPED: ["COMMITTING", "FAILED", "DISCARDED"],
    COMMITTING: ["CONFLICT", "FAILED"],
    COMMITTED: [],
    CONFLICT: [],
    FAILED: [],
    DISCARDED: [],
  };
  return transitions[current].includes(next);
}

function isTerminalRunState(state: WorkspaceRunState): boolean {
  return ["COMMITTED", "CONFLICT", "FAILED", "DISCARDED"].includes(state);
}

function validateFid(value: string): void {
  if (!FID_HEX_PATTERN.test(value)) {
    throw new RefStoreError("INVALID_REF_VALUE", "FID is invalid.");
  }
}

function validateId(value: string, label: string): void {
  if (!ID_HEX_PATTERN.test(value) || value === "0".repeat(32)) {
    throw new RefStoreError("INVALID_REF_VALUE", `${label} is invalid.`);
  }
}

function validateSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RefStoreError(
      "INVALID_REF_VALUE",
      `${label} must be a non-negative safe integer.`,
    );
  }
}

function validateTimestamp(value: number): void {
  validateSafeInteger(value, "timestamp");
}

function invalid(message: string): RefStoreError {
  return new RefStoreError("INVALID_REF_VALUE", message);
}

function fromHex(value: string): Buffer {
  return Buffer.from(value, "hex");
}

function toHex(value: Buffer): string {
  return value.toString("hex");
}

function isSqliteConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function corrupt(error: unknown): RefStoreError {
  return new RefStoreError(
    "REFSTORE_CORRUPT",
    "RefStore could not be opened or validated.",
    { cause: error },
  );
}
