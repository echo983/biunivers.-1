import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  DesktopItem,
  DesktopPosition,
  DesktopSurface,
  DesktopTarget,
} from "./types.js";

const TARGET_TYPES = new Set(["app", "file", "directory"]);
const APP_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
const ENTRY_ID_PATTERN = /^[0-9a-f]{32}$/;
const ITEM_ID_PATTERN = /^[0-9a-f]{32}$/;
const MAX_GRID_COORDINATE = 100_000;

export type DesktopSurfaceErrorCode =
  | "DESKTOP_SURFACE_INVALID"
  | "DESKTOP_SURFACE_CONFLICT"
  | "DESKTOP_ITEM_NOT_FOUND"
  | "DESKTOP_TARGET_EXISTS";

export class DesktopSurfaceError extends Error {
  constructor(
    public readonly code: DesktopSurfaceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DesktopSurfaceError";
  }
}

interface SurfaceRow {
  revision: number;
  initialized: number;
}

interface ItemRow {
  id: string;
  target_type: DesktopTarget["type"];
  target_handle: string;
  column_index: number;
  row_index: number;
  created_at_ms: number;
}

export class DesktopSurfaceStore {
  readonly #database: Database.Database;

  private constructor(
    readonly databasePath: string,
    database: Database.Database,
  ) {
    this.#database = database;
  }

  static async open(databasePath: string) {
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    database.exec(`
      CREATE TABLE IF NOT EXISTS desktop_surface (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL CHECK (schema_version = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        initialized INTEGER NOT NULL CHECK (initialized IN (0, 1))
      );
      INSERT OR IGNORE INTO desktop_surface
        (singleton, schema_version, revision, initialized)
      VALUES (1, 1, 0, 0);
      CREATE TABLE IF NOT EXISTS desktop_items (
        id TEXT PRIMARY KEY,
        target_type TEXT NOT NULL
          CHECK (target_type IN ('app', 'file', 'directory')),
        target_handle TEXT NOT NULL,
        column_index INTEGER NOT NULL CHECK (column_index >= 0),
        row_index INTEGER NOT NULL CHECK (row_index >= 0),
        created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
        UNIQUE (target_type, target_handle),
        UNIQUE (column_index, row_index)
      );
    `);
    return new DesktopSurfaceStore(databasePath, database);
  }

  close() {
    this.#database.close();
  }

  read(): DesktopSurface {
    const surface = this.#surfaceRow();
    const rows = this.#database
      .prepare(
        `SELECT id, target_type, target_handle, column_index, row_index,
                created_at_ms
         FROM desktop_items
         ORDER BY created_at_ms, id`,
      )
      .all() as ItemRow[];
    return {
      schemaVersion: 1,
      revision: surface.revision,
      items: rows.map(mapItem),
    };
  }

  initialize(targets: DesktopTarget[]) {
    const transaction = this.#database.transaction(() => {
      const surface = this.#surfaceRow();
      if (surface.initialized === 1) {
        return this.read();
      }
      const insert = this.#database.prepare(
        `INSERT INTO desktop_items
           (id, target_type, target_handle, column_index, row_index,
            created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const createdAtMs = Date.now();
      targets.forEach((target, index) => {
        validateTarget(target);
        insert.run(
          randomId(),
          target.type,
          target.handle,
          0,
          index,
          createdAtMs + index,
        );
      });
      this.#database
        .prepare(
          `UPDATE desktop_surface
           SET initialized = 1, revision = revision + 1
           WHERE singleton = 1`,
        )
        .run();
      return this.read();
    });
    return transaction();
  }

  add(
    target: DesktopTarget,
    position: DesktopPosition,
    expectedRevision: number,
  ) {
    validateTarget(target);
    validatePosition(position);
    return this.#mutate(expectedRevision, () => {
      try {
        this.#database
          .prepare(
            `INSERT INTO desktop_items
               (id, target_type, target_handle, column_index, row_index,
                created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            randomId(),
            target.type,
            target.handle,
            position.column,
            position.row,
            Date.now(),
          );
      } catch (error) {
        if (isConstraint(error, "desktop_items.target_type")) {
          throw new DesktopSurfaceError(
            "DESKTOP_TARGET_EXISTS",
            "目标已经在桌面上",
          );
        }
        if (isConstraint(error)) {
          throw new DesktopSurfaceError(
            "DESKTOP_SURFACE_CONFLICT",
            "桌面位置已被占用",
          );
        }
        throw error;
      }
    });
  }

  move(
    moves: Array<{ itemId: string; position: DesktopPosition }>,
    expectedRevision: number,
  ) {
    if (moves.length === 0 || new Set(moves.map((move) => move.itemId)).size !== moves.length) {
      throw invalid("moves 必须包含互不重复的项目");
    }
    for (const move of moves) {
      validateItemId(move.itemId);
      validatePosition(move.position);
    }
    return this.#mutate(expectedRevision, () => {
      const ids = new Set(
        (
          this.#database
            .prepare("SELECT id FROM desktop_items")
            .all() as Array<{ id: string }>
        ).map(({ id }) => id),
      );
      if (moves.some((move) => !ids.has(move.itemId))) {
        throw new DesktopSurfaceError(
          "DESKTOP_ITEM_NOT_FOUND",
          "要移动的桌面项目不存在",
        );
      }
      const requested = new Set(
        moves.map(({ position }) => `${position.column}:${position.row}`),
      );
      if (requested.size !== moves.length) {
        throw new DesktopSurfaceError(
          "DESKTOP_SURFACE_CONFLICT",
          "移动后的桌面位置重复",
        );
      }
      const movingIds = new Set(moves.map(({ itemId }) => itemId));
      const occupied = (
        this.#database
          .prepare(
            "SELECT id, column_index, row_index FROM desktop_items",
          )
          .all() as Array<{
          id: string;
          column_index: number;
          row_index: number;
        }>
      ).some(
        (row) =>
          !movingIds.has(row.id) &&
          requested.has(`${row.column_index}:${row.row_index}`),
      );
      if (occupied) {
        throw new DesktopSurfaceError(
          "DESKTOP_SURFACE_CONFLICT",
          "移动后的桌面位置已被占用",
        );
      }
      const update = this.#database.prepare(
        `UPDATE desktop_items
         SET column_index = ?, row_index = ?
         WHERE id = ?`,
      );
      // Temporarily move the group out of the valid coordinate range so swaps
      // do not violate the unique position index midway through the transaction.
      for (const move of moves) {
        this.#database
          .prepare(
            `UPDATE desktop_items
             SET column_index = column_index + ?, row_index = row_index + ?
             WHERE id = ?`,
          )
          .run(MAX_GRID_COORDINATE + 1, MAX_GRID_COORDINATE + 1, move.itemId);
      }
      for (const move of moves) {
        update.run(move.position.column, move.position.row, move.itemId);
      }
    });
  }

  remove(itemIds: string[], expectedRevision: number) {
    if (
      itemIds.length === 0 ||
      new Set(itemIds).size !== itemIds.length
    ) {
      throw invalid("itemIds 必须包含互不重复的项目");
    }
    itemIds.forEach(validateItemId);
    return this.#mutate(expectedRevision, () => {
      const remove = this.#database.prepare(
        "DELETE FROM desktop_items WHERE id = ?",
      );
      for (const itemId of itemIds) {
        if (remove.run(itemId).changes !== 1) {
          throw new DesktopSurfaceError(
            "DESKTOP_ITEM_NOT_FOUND",
            "要移除的桌面项目不存在",
          );
        }
      }
    });
  }

  reset(targets: DesktopTarget[], expectedRevision: number) {
    targets.forEach(validateTarget);
    return this.#mutate(expectedRevision, () => {
      this.#database.prepare("DELETE FROM desktop_items").run();
      const insert = this.#database.prepare(
        `INSERT INTO desktop_items
           (id, target_type, target_handle, column_index, row_index,
            created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const createdAtMs = Date.now();
      targets.forEach((target, index) => {
        insert.run(
          randomId(),
          target.type,
          target.handle,
          0,
          index,
          createdAtMs + index,
        );
      });
    });
  }

  #mutate(expectedRevision: number, mutation: () => void) {
    validateRevision(expectedRevision);
    const transaction = this.#database.transaction(() => {
      if (this.#surfaceRow().revision !== expectedRevision) {
        throw new DesktopSurfaceError(
          "DESKTOP_SURFACE_CONFLICT",
          "桌面已在其他页面中发生变化",
        );
      }
      mutation();
      this.#database
        .prepare(
          `UPDATE desktop_surface
           SET revision = revision + 1
           WHERE singleton = 1`,
        )
        .run();
      return this.read();
    });
    return transaction();
  }

  #surfaceRow() {
    return this.#database
      .prepare(
        "SELECT revision, initialized FROM desktop_surface WHERE singleton = 1",
      )
      .get() as SurfaceRow;
  }
}

function mapItem(row: ItemRow): DesktopItem {
  return {
    id: row.id,
    target: { type: row.target_type, handle: row.target_handle },
    position: { column: row.column_index, row: row.row_index },
    createdAtMs: row.created_at_ms,
  };
}

function validateTarget(target: DesktopTarget) {
  if (
    !target ||
    !TARGET_TYPES.has(target.type) ||
    typeof target.handle !== "string" ||
    (target.type === "app"
      ? !APP_ID_PATTERN.test(target.handle)
      : !ENTRY_ID_PATTERN.test(target.handle))
  ) {
    throw invalid("桌面目标无效");
  }
}

function validatePosition(position: DesktopPosition) {
  if (
    !position ||
    !Number.isSafeInteger(position.column) ||
    !Number.isSafeInteger(position.row) ||
    position.column < 0 ||
    position.row < 0 ||
    position.column > MAX_GRID_COORDINATE ||
    position.row > MAX_GRID_COORDINATE
  ) {
    throw invalid("桌面位置无效");
  }
}

function validateRevision(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw invalid("expectedRevision 无效");
  }
}

function validateItemId(value: string) {
  if (!ITEM_ID_PATTERN.test(value)) {
    throw invalid("桌面项目 ID 无效");
  }
}

function invalid(message: string) {
  return new DesktopSurfaceError("DESKTOP_SURFACE_INVALID", message);
}

function randomId() {
  return randomBytes(16).toString("hex");
}

function isConstraint(error: unknown, detail?: string) {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed") &&
    (!detail || error.message.includes(detail))
  );
}
