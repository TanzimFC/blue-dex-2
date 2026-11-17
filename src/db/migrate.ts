import type { Db } from './database.js';
import { migrations } from './migrations.js';

export function currentVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

/** Applies pending migrations in order, each in its own transaction. Refuses to run against a DB newer than the code. */
export function migrate(db: Db, now: () => number = Date.now): { from: number; to: number } {
  const from = currentVersion(db);
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (from > latest) throw new Error(`Database schema v${from} is newer than this build (v${latest}). Refusing to start.`);
  for (const m of migrations) {
    if (m.version <= from) continue;
    if (m.rebuildsTables) db.pragma('foreign_keys = OFF'); // must be set outside a transaction
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuildsTables) {
          const bad = db.pragma('foreign_key_check') as unknown[];
          if (bad.length) throw new Error(`migration v${m.version} left ${bad.length} foreign key violation(s); rolled back`);
        }
        db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(m.version, m.name, now());
      }).immediate();
    } finally {
      if (m.rebuildsTables) db.pragma('foreign_keys = ON');
    }
  }
  return { from, to: currentVersion(db) };
}
