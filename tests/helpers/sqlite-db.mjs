import { DatabaseSync } from "node:sqlite";
import { moduleLoader } from "./load-ts.mjs";

export function sqliteDb({ legacyIdentityFingerprint = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const sql of moduleLoader()("@/db/schema").schemaStatements) sqlite.exec(sql);
  if (legacyIdentityFingerprint) sqlite.exec("ALTER TABLE product_catalog ADD COLUMN identity_fingerprint TEXT");
  return {
    sqlite,
    prepare(sql) {
      return { bind(...args) {
        return {
          first: async () => sqlite.prepare(sql).get(...args) ?? null,
          all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
          run: async () => {
            // Node 22.13 has no StatementSync.columns(). all() executes reads
            // and writes exactly once, including statements with RETURNING.
            const before = sqlite.prepare("SELECT total_changes() AS total").get().total;
            const results = sqlite.prepare(sql).all(...args);
            const after = sqlite.prepare(`SELECT total_changes() AS total,
              changes() AS changes, last_insert_rowid() AS lastInsertRowid`).get();
            // changes() alone retains the previous write's count after a SELECT.
            const meta = after.total === before ? { changes: 0 }
              : { changes: after.changes, lastInsertRowid: after.lastInsertRowid };
            return { success: true, results, meta };
          },
        };
      } };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
}
