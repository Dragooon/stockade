import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import * as schema from './schema';

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL UNIQUE,
    agent_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`;

const CREATE_MESSAGES_TABLE = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`;

/** Run auto-migration: create tables if they don't exist */
function migrate(db: BetterSQLite3Database<typeof schema>) {
  db.run(sql.raw(CREATE_SESSIONS_TABLE));
  db.run(sql.raw(CREATE_MESSAGES_TABLE));
}

/** Get or create the database singleton */
export function getDb(dbPath?: string): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const resolvedPath = dbPath ?? 'data/platform.db';
  _sqlite = new Database(resolvedPath);
  _sqlite.pragma('journal_mode = WAL');
  _sqlite.pragma('foreign_keys = ON');

  _db = drizzle(_sqlite, { schema });
  migrate(_db);
  return _db;
}

export interface TestDb {
  db: BetterSQLite3Database<typeof schema>;
  close: () => void;
}

/** Create a fresh database connection (for tests) */
export function createDb(dbPath: string): TestDb {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  migrate(db);
  return {
    db,
    close: () => sqlite.close(),
  };
}

/** Close the singleton connection */
export function closeDb() {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = null;
    _db = null;
  }
}
