import Database from 'better-sqlite3';
import { runMigrations } from './migrations';
import path from 'node:path';
import fs from 'node:fs';

export function openDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
