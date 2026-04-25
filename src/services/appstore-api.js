import crypto from 'node:crypto';
import { getAppById, getDefaultApp, isAppApiConfigured } from './apps.js';

/**
 * App Store Server API client (multi-app capable).
 *
 * Each app is configured via the apps registry (see `src/services/apps.js`):
 *   { id, bundle_id, environment, issuer_id, key_id, private_key }
 *
 * Public methods take an `app` object (or app id string). When omitted, the
 * default (first configured) app is used. JWT bearer tokens are cached per app.
 *
 * Docs:
 *  - https://developer.apple.com/documentation/appstoreserverapi
 *  - https://developer.apple.com/documentation/appstoreserverapi/creating_api_keys_to_use_with_the_app_store_server_api
 */

const HOSTS = {
  PRODUCTION: 'https://api.storekit.itunes.apple.com',
  SANDBOX:    'https://api.storekit-sandbox.itunes.apple.com',
};

function normalizeEnvironment(env) {
  return (env || 'Production').toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
}

function host(env) {
  return normalizeEnvironment(env) === 'SANDBOX' ? HOSTS.SANDBOX : HOSTS.PRODUCTION;
}

function resolveApp(appOrId) {
  if (!appOrId) return getDefaultApp();
  if (typeof appOrId === 'string') return getAppById(appOrId);
  return appOrId; // assume already a normalized app object
}

/** True if at least one app has full API credentials. */
export function isConfigured(appOrId) {
  if (appOrId === undefined) {
    const app = getDefaultApp();
    return !!app && isAppApiConfigured(app);
  }
  const app = resolveApp(appOrId);
  return !!app && isAppApiConfigured(app);
}

// ---------------------------------------------------------------
// JWT bearer token (ES256, signed with each app's .p8 key)
// ---------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

const tokenCache = new Map(); // appId -> { token, exp }

function generateToken(app) {
  if (!app) throw new Error('appstore_api_no_app');
  if (!isAppApiConfigured(app)) {
    throw new Error(`appstore_api_not_configured: app "${app.id}" is missing issuer_id, key_id, private_key or bundle_id`);
  }

  const cached = tokenCache.get(app.id);
  if (cached && cached.exp > Date.now() / 1000 + 60) {
    return cached.token;
  }

  const header = { alg: 'ES256', kid: app.key_id, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 20 * 60;
  const payload = {
    iss: app.issuer_id,
    iat: now,
    exp,
    aud: 'appstoreconnect-v1',
    bid: app.bundle_id,
  };

  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = Buffer.from(`${h}.${p}`);
  const key = crypto.createPrivateKey(app.private_key);
  const der = crypto.sign('SHA256', signingInput, key);
  const raw = ecdsaDerToRaw(der);
  const token = `${h}.${p}.${b64url(raw)}`;

  tokenCache.set(app.id, { token, exp });
  return token;
}

/** ECDSA DER → raw r||s (64 bytes for P-256). */
function ecdsaDerToRaw(der) {
  if (der[0] !== 0x30) throw new Error('invalid DER signature');
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  if (der[i] !== 0x02) throw new Error('invalid DER r');
  const rLen = der[i + 1];
  let r = der.slice(i + 2, i + 2 + rLen);
  i = i + 2 + rLen;
  if (der[i] !== 0x02) throw new Error('invalid DER s');
  const sLen = der[i + 1];
  let s = der.slice(i + 2, i + 2 + sLen);

  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const rPad = Buffer.concat([Buffer.alloc(32 - r.length, 0), r]);
  const sPad = Buffer.concat([Buffer.alloc(32 - s.length, 0), s]);
  return Buffer.concat([rPad, sPad]);
}

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------

async function appleRequest(method, path, { app, query = {}, body, environment } = {}) {
  const resolvedApp = resolveApp(app);
  if (!resolvedApp) throw new Error('appstore_api_no_app');

  const env = environment || resolvedApp.environment;
  const url = new URL(`${host(env)}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const headers = {
    authorization: `Bearer ${generateToken(resolvedApp)}`,
    accept: 'application/json',
  };
  if (body != null) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers,
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  if (!res.ok) {
    const err = new Error(
      `appstore_api_${res.status}: ${
        typeof parsed === 'string' ? parsed : (parsed.errorMessage || JSON.stringify(parsed))
      }`
    );
    err.status = res.status;
    err.body = parsed;
    err.app_id = resolvedApp.id;
    throw err;
  }
  return parsed;
}

async function appleGet(path, query = {}, opts = {}) {
  return appleRequest('GET', path, { query, ...opts });
}

async function applePost(path, body = {}, opts = {}) {
  return appleRequest('POST', path, { body, ...opts });
}

// ---------------------------------------------------------------
// Public API (each accepts { app, environment, ... } where app is the app id or object)
// ---------------------------------------------------------------

export async function getTransactionInfo(transactionId, opts = {}) {
  return appleGet(
    `/inApps/v1/transactions/${encodeURIComponent(transactionId)}`,
    {},
    opts
  );
}

export async function getTransactionHistory(transactionId, opts = {}) {
  const all = [];
  let revision = opts.revision || null;
  let pages = 0;
  const maxPages = opts.maxPages ?? 20;

  while (true) {
    const data = await appleGet(`/inApps/v2/history/${encodeURIComponent(transactionId)}`, {
      revision: revision || undefined,
      sort: opts.sort || 'ASCENDING',
      productType: opts.productType,
      startDate: opts.startDate,
      endDate: opts.endDate,
      revoked: opts.revoked,
      inAppOwnershipType: opts.inAppOwnershipType,
    }, { app: opts.app, environment: opts.environment });

    if (Array.isArray(data.signedTransactions)) {
      all.push(...data.signedTransactions);
    }

    pages++;
    if (!data.hasMore || pages >= maxPages) break;
    revision = data.revision;
    if (!revision) break;
  }
  return all;
}

export async function getSubscriptionStatuses(transactionId, opts = {}) {
  return appleGet(
    `/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`,
    { status: opts.status },
    { app: opts.app, environment: opts.environment }
  );
}

export async function getRefundHistory(transactionId, opts = {}) {
  const all = [];
  let revision = opts.revision || null;
  let pages = 0;
  const maxPages = opts.maxPages ?? 10;

  while (true) {
    const data = await appleGet(`/inApps/v2/refund/lookup/${encodeURIComponent(transactionId)}`, {
      revision: revision || undefined,
    }, { app: opts.app, environment: opts.environment });
    if (Array.isArray(data.signedTransactions)) {
      all.push(...data.signedTransactions);
    }
    pages++;
    if (!data.hasMore || pages >= maxPages) break;
    revision = data.revision;
    if (!revision) break;
  }
  return all;
}

export async function requestTestNotification(opts = {}) {
  return applePost('/inApps/v1/notifications/test', {}, opts);
}

export async function getTestNotificationStatus(testNotificationToken, opts = {}) {
  return appleGet(
    `/inApps/v1/notifications/test/${encodeURIComponent(testNotificationToken)}`,
    {},
    opts
  );
}
