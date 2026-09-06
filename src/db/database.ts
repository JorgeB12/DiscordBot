import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateLibrary } from "./library.js";

/**
 * Base de datos SQLite del bot (módulo `node:sqlite`, incluido en Node 22.13+,
 * sin dependencias nativas). Vive en `data/bemol.db` junto al proyecto.
 */

const DB_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DB_DIR, "bemol.db");

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(DB_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 3000");
  migrate(db);
  migrateLibrary();
  return db;
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      dj_role_id TEXT,
      default_volume INTEGER,
      stay_247 INTEGER NOT NULL DEFAULT 0,
      idle_leave_min INTEGER,
      empty_leave_min INTEGER,
      voteskip INTEGER NOT NULL DEFAULT 1,
      voteskip_percent INTEGER NOT NULL DEFAULT 50,
      voteskip_min_listeners INTEGER NOT NULL DEFAULT 3,
      music_channel_id TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS guild_djs (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      guild_id TEXT PRIMARY KEY,
      voice_channel_id TEXT NOT NULL,
      text_channel_id TEXT,
      current_json TEXT,
      queue_json TEXT NOT NULL,
      position_ms INTEGER NOT NULL DEFAULT 0,
      volume INTEGER NOT NULL,
      loop_mode TEXT NOT NULL,
      paused INTEGER NOT NULL DEFAULT 0,
      saved_at INTEGER NOT NULL
    );
  `);
  addColumnIfMissing(database, "guild_settings", "autoplay", "INTEGER NOT NULL DEFAULT 0");
}

function addColumnIfMissing(database: DatabaseSync, table: string, column: string, definition: string): void {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function closeDb(): void {
  db?.close();
  db = null;
}
