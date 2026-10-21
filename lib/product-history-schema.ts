// Keep these statements equivalent to drizzle/0021_product_history_summaries.sql.
// Run the complete list in one D1 batch so backfill, triggers and ready marker
// become visible together. The gate precedes the history table in each scan;
// subsequent cold starts inspect the marker without walking existing events.
export const historySchemaStatements = [
  `CREATE TABLE IF NOT EXISTS product_history_summaries (
    owner_id TEXT NOT NULL,
    product_id TEXT NOT NULL,
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    unread_count INTEGER NOT NULL CHECK (unread_count >= 0 AND unread_count <= event_count),
    PRIMARY KEY (owner_id, product_id)
  )`,
  `CREATE TABLE IF NOT EXISTS product_history_state (
    owner_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    event_count INTEGER NOT NULL CHECK (event_count >= 0)
  )`,
  `CREATE TABLE IF NOT EXISTS product_history_cache (
    owner_id TEXT NOT NULL,
    limit_value INTEGER NOT NULL CHECK (limit_value > 0),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    payload TEXT NOT NULL,
    PRIMARY KEY (owner_id, limit_value)
  )`,
  `CREATE TABLE IF NOT EXISTS product_history_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL
  )`,
  `INSERT INTO product_history_summaries (owner_id, product_id, event_count, unread_count)
    SELECT events.owner_id, events.product_id, COUNT(*),
      SUM(CASE WHEN events.attention = 1 AND events.read_at IS NULL THEN 1 ELSE 0 END)
    FROM (SELECT 1 WHERE NOT EXISTS (
      SELECT 1 FROM product_history_meta WHERE singleton = 1 AND version >= 1
    )) AS bootstrap CROSS JOIN product_change_events AS events
    GROUP BY events.owner_id, events.product_id
    ON CONFLICT (owner_id, product_id) DO UPDATE SET
      event_count = excluded.event_count, unread_count = excluded.unread_count`,
  `INSERT INTO product_history_state (owner_id, revision, event_count)
    SELECT events.owner_id, 1, COUNT(*)
    FROM (SELECT 1 WHERE NOT EXISTS (
      SELECT 1 FROM product_history_meta WHERE singleton = 1 AND version >= 1
    )) AS bootstrap CROSS JOIN product_change_events AS events
    GROUP BY events.owner_id
    ON CONFLICT (owner_id) DO UPDATE SET revision = excluded.revision, event_count = excluded.event_count`,
  `CREATE TRIGGER IF NOT EXISTS product_history_identity_immutable
    BEFORE UPDATE OF owner_id, product_id, event_id ON product_change_events
    WHEN NEW.owner_id IS NOT OLD.owner_id OR NEW.product_id IS NOT OLD.product_id
      OR NEW.event_id IS NOT OLD.event_id
    BEGIN
      SELECT RAISE(ABORT, 'product history identity is immutable');
    END`,
  `CREATE TRIGGER IF NOT EXISTS product_history_after_insert
    AFTER INSERT ON product_change_events
    BEGIN
      INSERT INTO product_history_summaries (owner_id, product_id, event_count, unread_count)
        VALUES (NEW.owner_id, NEW.product_id, 1,
          CASE WHEN NEW.attention = 1 AND NEW.read_at IS NULL THEN 1 ELSE 0 END)
        ON CONFLICT (owner_id, product_id) DO UPDATE SET
          event_count = event_count + 1, unread_count = unread_count + excluded.unread_count;
      INSERT INTO product_history_state (owner_id, revision, event_count)
        VALUES (NEW.owner_id, 1, 1)
        ON CONFLICT (owner_id) DO UPDATE SET revision = revision + 1, event_count = event_count + 1;
    END`,
  `CREATE TRIGGER IF NOT EXISTS product_history_after_update
    AFTER UPDATE ON product_change_events
    WHEN NEW.read_at IS NOT OLD.read_at OR NEW.attention IS NOT OLD.attention
      OR NEW.change_type IS NOT OLD.change_type OR NEW.title IS NOT OLD.title
      OR NEW.before_value IS NOT OLD.before_value OR NEW.after_value IS NOT OLD.after_value
      OR NEW.observed_at IS NOT OLD.observed_at OR NEW.source IS NOT OLD.source
    BEGIN
      UPDATE product_history_summaries SET unread_count = unread_count
        + CASE WHEN NEW.attention = 1 AND NEW.read_at IS NULL THEN 1 ELSE 0 END
        - CASE WHEN OLD.attention = 1 AND OLD.read_at IS NULL THEN 1 ELSE 0 END
        WHERE owner_id = NEW.owner_id AND product_id = NEW.product_id;
      UPDATE product_history_state SET revision = revision + 1 WHERE owner_id = NEW.owner_id;
    END`,
  `CREATE TRIGGER IF NOT EXISTS product_history_after_delete
    AFTER DELETE ON product_change_events
    BEGIN
      UPDATE product_history_summaries SET event_count = event_count - 1,
        unread_count = unread_count
          - CASE WHEN OLD.attention = 1 AND OLD.read_at IS NULL THEN 1 ELSE 0 END
        WHERE owner_id = OLD.owner_id AND product_id = OLD.product_id;
      DELETE FROM product_history_summaries
        WHERE owner_id = OLD.owner_id AND product_id = OLD.product_id AND event_count = 0;
      UPDATE product_history_state SET revision = revision + 1, event_count = event_count - 1
        WHERE owner_id = OLD.owner_id;
    END`,
  `INSERT INTO product_history_meta (singleton, version) VALUES (1, 1)
    ON CONFLICT (singleton) DO UPDATE SET version = excluded.version WHERE product_history_meta.version < 1`,
] as const;
