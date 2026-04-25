import Database from 'better-sqlite3';
import { mkdirSync, accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

const dbPath = resolve(process.env.DB_PATH || './data/revenue.db');
const dbDir = dirname(dbPath);

console.log(`[db] opening database at ${dbPath}`);

try {
  mkdirSync(dbDir, { recursive: true });
  accessSync(dbDir, constants.R_OK | constants.W_OK);
} catch (err) {
  console.error(`[db] cannot prepare directory ${dbDir}:`, err.message);
  console.error('[db] hint: make sure the Railway volume mount path matches DB_PATH, and set RAILWAY_RUN_UID=0 if your container runs as a non-root user.');
  throw err;
}

let db;
try {
  db = new Database(dbPath);
} catch (err) {
  console.error(`[db] failed to open sqlite file at ${dbPath}:`, err.message);
  throw err;
}

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');

export { db };

// ---------------------------------------------------------------
// Base table definitions (idempotent)
//
// IMPORTANT: indexes that reference new columns (`app_id`) live in a separate
// `db.exec` block AFTER the migration step below, so legacy databases can be
// migrated to the new schema before any `CREATE INDEX` runs.
// ---------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    bundle_id     TEXT NOT NULL UNIQUE,
    environment   TEXT NOT NULL DEFAULT 'Production',
    created_at_ms INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           TEXT UNIQUE,
    app_id             TEXT,
    type               TEXT NOT NULL,
    app_user_id        TEXT,
    original_app_user_id TEXT,
    aliases            TEXT,
    product_id         TEXT,
    entitlement_ids    TEXT,
    period_type        TEXT,
    purchased_at_ms    INTEGER,
    expiration_at_ms   INTEGER,
    event_timestamp_ms INTEGER NOT NULL,
    environment        TEXT,
    store              TEXT,
    currency           TEXT,
    price              REAL,
    price_usd          REAL,
    country_code       TEXT,
    is_family_share    INTEGER DEFAULT 0,
    is_trial_conversion INTEGER DEFAULT 0,
    cancel_reason      TEXT,
    expiration_reason  TEXT,
    transaction_id     TEXT,
    original_transaction_id TEXT,
    web_order_line_item_id TEXT,
    offer_code         TEXT,
    raw_json           TEXT,
    received_at_ms     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subscribers (
    app_id               TEXT NOT NULL DEFAULT '',
    app_user_id          TEXT NOT NULL,
    original_app_user_id TEXT,
    first_seen_ms        INTEGER NOT NULL,
    last_event_ms        INTEGER NOT NULL,
    status               TEXT NOT NULL DEFAULT 'active',
    current_product_id   TEXT,
    current_entitlements TEXT,
    period_type          TEXT,
    current_price_usd    REAL,
    expiration_ms        INTEGER,
    country_code         TEXT,
    store                TEXT,
    environment          TEXT,
    will_renew           INTEGER DEFAULT 1,
    renewals_count       INTEGER DEFAULT 0,
    ltv_usd              REAL DEFAULT 0,
    refunded_usd         REAL DEFAULT 0,
    trial_converted      INTEGER DEFAULT 0,
    ever_trial           INTEGER DEFAULT 0,
    cancelled_at_ms      INTEGER,
    cancel_reason        TEXT,
    PRIMARY KEY (app_id, app_user_id)
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER,
    app_id          TEXT,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT,
    severity        TEXT DEFAULT 'info',
    amount_usd      REAL,
    app_user_id     TEXT,
    product_id      TEXT,
    created_at_ms   INTEGER NOT NULL
  );
`);

// ---------------------------------------------------------------
// Indexes that don't depend on new columns — safe to create early.
// ---------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_user ON events(app_user_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_events_product ON events(product_id);
  CREATE INDEX IF NOT EXISTS idx_events_original_tx ON events(original_transaction_id);

  CREATE INDEX IF NOT EXISTS idx_subs_status ON subscribers(status);
  CREATE INDEX IF NOT EXISTS idx_subs_expiration ON subscribers(expiration_ms);
  CREATE INDEX IF NOT EXISTS idx_subs_product ON subscribers(current_product_id);
  CREATE INDEX IF NOT EXISTS idx_subs_country ON subscribers(country_code);

  CREATE INDEX IF NOT EXISTS idx_notifications_time ON notifications(created_at_ms);
`);

// ---------------------------------------------------------------
// Migrations from earlier (pre-multi-app) schemas
// ---------------------------------------------------------------
function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
}

(function migrateForMultiApp() {
  // 1. events.app_id (added if migrating from earlier schema)
  if (!tableColumns('events').includes('app_id')) {
    db.exec(`ALTER TABLE events ADD COLUMN app_id TEXT;`);
    console.log('[db][migrate] added events.app_id');
  }

  // 2. notifications.app_id
  if (!tableColumns('notifications').includes('app_id')) {
    db.exec(`ALTER TABLE notifications ADD COLUMN app_id TEXT;`);
    console.log('[db][migrate] added notifications.app_id');
  }

  // 3. subscribers needs app_id + composite PK. SQLite can't add a column to
  //    an existing PRIMARY KEY in-place, so we recreate the table.
  const subsCols = tableColumns('subscribers');
  if (subsCols.length > 0 && !subsCols.includes('app_id')) {
    db.exec(`
      ALTER TABLE subscribers RENAME TO subscribers_old_premulti;

      CREATE TABLE subscribers (
        app_id               TEXT NOT NULL DEFAULT '',
        app_user_id          TEXT NOT NULL,
        original_app_user_id TEXT,
        first_seen_ms        INTEGER NOT NULL,
        last_event_ms        INTEGER NOT NULL,
        status               TEXT NOT NULL DEFAULT 'active',
        current_product_id   TEXT,
        current_entitlements TEXT,
        period_type          TEXT,
        current_price_usd    REAL,
        expiration_ms        INTEGER,
        country_code         TEXT,
        store                TEXT,
        environment          TEXT,
        will_renew           INTEGER DEFAULT 1,
        renewals_count       INTEGER DEFAULT 0,
        ltv_usd              REAL DEFAULT 0,
        refunded_usd         REAL DEFAULT 0,
        trial_converted      INTEGER DEFAULT 0,
        ever_trial           INTEGER DEFAULT 0,
        cancelled_at_ms      INTEGER,
        cancel_reason        TEXT,
        PRIMARY KEY (app_id, app_user_id)
      );

      INSERT INTO subscribers (
        app_id, app_user_id, original_app_user_id, first_seen_ms, last_event_ms, status,
        current_product_id, current_entitlements, period_type, current_price_usd,
        expiration_ms, country_code, store, environment, will_renew,
        renewals_count, ltv_usd, refunded_usd, trial_converted, ever_trial,
        cancelled_at_ms, cancel_reason
      )
      SELECT '', app_user_id, original_app_user_id, first_seen_ms, last_event_ms, status,
             current_product_id, current_entitlements, period_type, current_price_usd,
             expiration_ms, country_code, store, environment, will_renew,
             renewals_count, ltv_usd, refunded_usd, trial_converted, ever_trial,
             cancelled_at_ms, cancel_reason
      FROM subscribers_old_premulti;

      DROP TABLE subscribers_old_premulti;

      CREATE INDEX IF NOT EXISTS idx_subs_status ON subscribers(status);
      CREATE INDEX IF NOT EXISTS idx_subs_expiration ON subscribers(expiration_ms);
      CREATE INDEX IF NOT EXISTS idx_subs_product ON subscribers(current_product_id);
      CREATE INDEX IF NOT EXISTS idx_subs_country ON subscribers(country_code);
    `);
    console.log('[db][migrate] rebuilt subscribers with composite PK (app_id, app_user_id)');
  }
})();

// ---------------------------------------------------------------
// Indexes that depend on `app_id` — created AFTER migrations to ensure the
// column exists in all branches (fresh install or upgrade).
// ---------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_app ON events(app_id);
  CREATE INDEX IF NOT EXISTS idx_events_app_user ON events(app_id, app_user_id);
  CREATE INDEX IF NOT EXISTS idx_subs_app ON subscribers(app_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_app ON notifications(app_id);
`);

export function close() {
  db.close();
}
