import { readFileSync, existsSync } from 'node:fs';
import { db } from '../db.js';

/**
 * Apps registry — multi-app support.
 *
 * Two configuration modes:
 *
 *   A) Multi-app via APPS_CONFIG (JSON array, recommended for >1 app):
 *
 *      APPS_CONFIG='[
 *        { "id": "myapp",  "bundle_id": "com.acme.myapp" },
 *        { "id": "myapp2", "bundle_id": "com.acme.myapp2", "environment": "Sandbox" }
 *      ]'
 *
 *      App Store Server API credentials (issuer_id, key_id, private_key) are
 *      shared across an Apple Developer team, so by default they are read once
 *      from the global APPSTORE_ISSUER_ID / APPSTORE_KEY_ID /
 *      APPSTORE_PRIVATE_KEY[_PATH] env vars and applied to every app.
 *
 *      Per-app override is still supported (different team / different key per
 *      app). Just include `issuer_id`, `key_id`, `private_key` (or
 *      `private_key_path`) inside that app's JSON entry.
 *
 *   B) Single-app via legacy env vars (fully backward compatible):
 *
 *      APPSTORE_BUNDLE_ID, APPSTORE_ISSUER_ID, APPSTORE_KEY_ID,
 *      APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_ENVIRONMENT
 *
 *      The single app's `id` defaults to APPSTORE_APP_ID, otherwise to the
 *      bundle_id verbatim.
 *
 * Once loaded, the registry mirrors the public app metadata into the `apps`
 * table so SQL queries can JOIN if needed. Secrets (private_key, issuer_id,
 * key_id) live only in memory.
 */

const _byId = new Map();
const _byBundleId = new Map();

function readPrivateKey(inline, path) {
  if (inline && inline.includes('BEGIN')) {
    return inline.replace(/\\n/g, '\n').trim();
  }
  if (path && existsSync(path)) {
    return readFileSync(path, 'utf8').trim();
  }
  return null;
}

function normalizeApp(raw, defaults = {}) {
  if (!raw || typeof raw !== 'object') return null;

  const bundleId = (raw.bundle_id || raw.bundleId || '').toString().trim();
  if (!bundleId) return null;

  const id = (raw.id || raw.app_id || raw.appId || raw.slug || bundleId)
    .toString()
    .trim();
  if (!id) return null;

  const envRaw = (raw.environment || raw.env || defaults.environment || 'Production')
    .toString()
    .trim();
  const environment = /sandbox/i.test(envRaw) ? 'Sandbox' : 'Production';

  // Per-app credentials override the team-wide defaults. Apple App Store
  // Server API keys are tied to a Developer team, so most setups can leave
  // these empty per-app and let `defaults` (from APPSTORE_* env) provide them.
  const inlineKey = raw.private_key || raw.privateKey;
  const keyPath = raw.private_key_path || raw.privateKeyPath;
  const privateKey =
    readPrivateKey(inlineKey, keyPath) ?? defaults.private_key ?? null;

  const issuerId =
    (raw.issuer_id || raw.issuerId || '').toString().trim() ||
    defaults.issuer_id ||
    null;

  const keyId =
    (raw.key_id || raw.keyId || '').toString().trim() ||
    defaults.key_id ||
    null;

  return {
    id,
    name: (raw.name || id).toString(),
    bundle_id: bundleId,
    environment,
    issuer_id: issuerId,
    key_id: keyId,
    private_key: privateKey,
  };
}

function readGlobalCredentials() {
  // Team-wide defaults read from legacy APPSTORE_* env vars; these are reused
  // by every app in APPS_CONFIG unless that app overrides them explicitly.
  const issuer = (process.env.APPSTORE_ISSUER_ID || '').trim() || null;
  const key = (process.env.APPSTORE_KEY_ID || '').trim() || null;
  const privKey = readPrivateKey(
    process.env.APPSTORE_PRIVATE_KEY,
    process.env.APPSTORE_PRIVATE_KEY_PATH
  );
  const env = (process.env.APPSTORE_ENVIRONMENT || '').trim() || null;
  return {
    issuer_id: issuer,
    key_id: key,
    private_key: privKey,
    environment: env,
  };
}

function loadFromEnv() {
  const apps = [];
  const globals = readGlobalCredentials();

  // (A) APPS_CONFIG JSON
  const raw = process.env.APPS_CONFIG;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const a of arr) {
          const n = normalizeApp(a, globals);
          if (n) apps.push(n);
        }
      } else {
        console.warn('[apps] APPS_CONFIG must be a JSON array, ignoring.');
      }
    } catch (err) {
      console.warn(`[apps] APPS_CONFIG parse failed: ${err.message}. Falling back to legacy env.`);
    }
  }

  // (B) Legacy single-app fallback (only if APPS_CONFIG produced nothing)
  if (apps.length === 0 && process.env.APPSTORE_BUNDLE_ID) {
    const bundleId = process.env.APPSTORE_BUNDLE_ID.trim();
    const id = (process.env.APPSTORE_APP_ID || bundleId).trim();
    const legacy = normalizeApp(
      {
        id,
        name: process.env.APPSTORE_APP_NAME || id,
        bundle_id: bundleId,
        environment: process.env.APPSTORE_ENVIRONMENT || 'Production',
      },
      globals
    );
    if (legacy) apps.push(legacy);
  }

  return apps;
}

const upsertAppStmt = db.prepare(`
  INSERT INTO apps (id, name, bundle_id, environment, created_at_ms)
  VALUES (@id, @name, @bundle_id, @environment, @created_at_ms)
  ON CONFLICT(id) DO UPDATE SET
    name        = excluded.name,
    bundle_id   = excluded.bundle_id,
    environment = excluded.environment
`);

export function reloadApps() {
  const apps = loadFromEnv();

  _byId.clear();
  _byBundleId.clear();

  const now = Date.now();
  for (const app of apps) {
    _byId.set(app.id, app);
    _byBundleId.set(app.bundle_id, app);
    upsertAppStmt.run({
      id: app.id,
      name: app.name,
      bundle_id: app.bundle_id,
      environment: app.environment,
      created_at_ms: now,
    });
  }

  if (apps.length === 0) {
    console.warn('[apps] No apps configured. Set APPS_CONFIG (JSON array) or legacy APPSTORE_* env vars.');
  } else {
    console.log(`[apps] Loaded ${apps.length} app(s): ${apps.map(a => `${a.id}(${a.bundle_id})`).join(', ')}`);
  }

  // After reloading, rows that had NULL app_id (e.g. before the migration ran
  // or seeded test data) should be associated with the default app.
  const defaultApp = apps[0];
  if (defaultApp) {
    db.prepare(`UPDATE events SET app_id = ? WHERE app_id IS NULL OR app_id = ''`).run(defaultApp.id);
    db.prepare(`UPDATE notifications SET app_id = ? WHERE app_id IS NULL OR app_id = ''`).run(defaultApp.id);
    db.prepare(`UPDATE subscribers SET app_id = ? WHERE app_id IS NULL OR app_id = ''`).run(defaultApp.id);
  }

  return apps;
}

export function getApps() {
  return Array.from(_byId.values());
}

export function getAppIds() {
  return Array.from(_byId.keys());
}

export function getAppById(id) {
  if (!id) return null;
  return _byId.get(id) || null;
}

export function getAppByBundleId(bundleId) {
  if (!bundleId) return null;
  return _byBundleId.get(bundleId) || null;
}

export function getDefaultApp() {
  return _byId.values().next().value || null;
}

export function isAppApiConfigured(app) {
  return !!(app && app.bundle_id && app.issuer_id && app.key_id && app.private_key);
}

/**
 * Resolve the `app_id` for an incoming notification:
 *   1. By bundleId if provided  (preferred — exact match)
 *   2. Fallback to default app  (lenient mode — useful for /webhook/test)
 *   3. Returns null if no apps are configured
 */
export function resolveAppForBundleId(bundleId, { strict = false } = {}) {
  const exact = getAppByBundleId(bundleId);
  if (exact) return exact;
  if (strict) return null;
  return getDefaultApp();
}

/** Public-safe app metadata (no secrets) for the API. */
export function publicApp(app) {
  if (!app) return null;
  return {
    id: app.id,
    name: app.name,
    bundle_id: app.bundle_id,
    environment: app.environment,
    api_configured: isAppApiConfigured(app),
  };
}
