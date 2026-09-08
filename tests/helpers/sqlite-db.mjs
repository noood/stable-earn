import { DatabaseSync } from "node:sqlite";
import { moduleLoader } from "./load-ts.mjs";

export function sqliteDb() {
  const sqlite = new DatabaseSync(":memory:");
  for (const sql of moduleLoader()("@/db/schema").schemaStatements) sqlite.exec(sql);
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
