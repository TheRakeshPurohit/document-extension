import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import path from 'path';
import fs from 'fs';
import * as schema from './schema.js';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'docext.db');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'screenshots'), { recursive: true });

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Auto-migrate: create tables if they don't exist
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    start_url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    url TEXT NOT NULL,
    page_title TEXT NOT NULL,
    metadata TEXT NOT NULL,
    screenshot_id TEXT,
    alt_screenshot_id TEXT,
    sort_order INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS steps (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    screenshot_id TEXT,
    alt_screenshot_id TEXT,
    source_event_ids TEXT NOT NULL DEFAULT '[]',
    is_edited INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS screenshots (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_session_order ON events(session_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_steps_session ON steps(session_id);
  CREATE INDEX IF NOT EXISTS idx_steps_session_order ON steps(session_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_screenshots_session ON screenshots(session_id);
`);

// Add columns to existing tables (safe to fail if already present)
try { sqlite.exec('ALTER TABLE events ADD COLUMN alt_screenshot_id TEXT'); } catch {}
try { sqlite.exec('ALTER TABLE steps ADD COLUMN alt_screenshot_id TEXT'); } catch {}
try { sqlite.exec("ALTER TABLE steps ADD COLUMN sub_steps TEXT NOT NULL DEFAULT '[]'"); } catch {}
try { sqlite.exec('ALTER TABLE steps ADD COLUMN merge_with_next_id TEXT'); } catch {}

export const db = drizzle(sqlite, { schema });

export { schema };
export { DATA_DIR, DB_PATH };
