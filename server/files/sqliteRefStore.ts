import { randomUUID } from "node:crypto";
import { access, link, mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";

const SCHEMA_VERSION = 1;
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

export type RefStoreErrorCode =
  | "REFSTORE_MISSING"
  | "REFSTORE_CORRUPT"
  | "REF_ALREADY_EXISTS"
  | "REF_NOT_FOUND"
  | "REF_CONFLICT"
  | "SNAPSHOT_ALREADY_EXISTS"
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
    CREATE TABLE file_service_meta (
      key TEXT PRIMARY KEY,
      value BLOB NOT NULL
    ) STRICT;
    INSERT INTO file_service_meta(key, value)
    VALUES ('schema_version', X'00000001');
    PRAGMA user_version = ${SCHEMA_VERSION};
    COMMIT;
  `);
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
    "file_service_meta",
  ];
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name IN (?, ?, ?)`,
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
