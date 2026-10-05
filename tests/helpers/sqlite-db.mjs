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
          run: async () => ({ meta: sqlite.prepare(sql).run(...args) }),
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
