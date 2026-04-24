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

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           TEXT UNIQUE,
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

  CREATE INDEX IF NOT EXISTS idx_events_user ON events(app_user_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
  CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_timestamp_ms);
  CREATE INDEX IF NOT EXISTS idx_events_product ON events(product_id);
  CREATE INDEX IF NOT EXISTS idx_events_original_tx ON events(original_transaction_id);

  CREATE TABLE IF NOT EXISTS subscribers (
    app_user_id          TEXT PRIMARY KEY,
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
    cancel_reason        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_subs_status ON subscribers(status);
  CREATE INDEX IF NOT EXISTS idx_subs_expiration ON subscribers(expiration_ms);
  CREATE INDEX IF NOT EXISTS idx_subs_product ON subscribers(current_product_id);
  CREATE INDEX IF NOT EXISTS idx_subs_country ON subscribers(country_code);

  CREATE TABLE IF NOT EXISTS notifications (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id        INTEGER,
    type            TEXT NOT NULL,
    title           TEXT NOT NULL,
    body            TEXT,
    severity        TEXT DEFAULT 'info',
    amount_usd      REAL,
    app_user_id     TEXT,
    product_id      TEXT,
    created_at_ms   INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_time ON notifications(created_at_ms);
`);

export function close() {
  db.close();
}
