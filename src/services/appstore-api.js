import crypto from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

/**
 * App Store Server API client.
 *
 * Docs:
 *  - https://developer.apple.com/documentation/appstoreserverapi
 *  - https://developer.apple.com/documentation/appstoreserverapi/creating_api_keys_to_use_with_the_app_store_server_api
 *
 * Required env:
 *   APPSTORE_ISSUER_ID         (UUID; App Store Connect → Users and Access → Integrations)
 *   APPSTORE_KEY_ID            (10-char ID for the In-App Purchase API key)
 *   APPSTORE_PRIVATE_KEY       (.p8 PEM string)  *or*
 *   APPSTORE_PRIVATE_KEY_PATH  (path to the .p8 file)
 *   APPSTORE_BUNDLE_ID         (e.g. com.acme.app)
 *   APPSTORE_ENVIRONMENT       ("Production" | "Sandbox", default Production)
 *
 * Notes:
 *  - Apple supports two parallel environments. Sandbox has its own API host and tokens.
 *  - Tokens are short-lived (≤60 min). We cache for ~20 min.
 *  - Each transaction in history is itself a JWS signed by Apple. We decode them with the
 *    same JWS utilities used for incoming notifications.
 */

const HOSTS = {
  PRODUCTION: 'https://api.storekit.itunes.apple.com',
  SANDBOX:    'https://api.storekit-sandbox.itunes.apple.com',
};

function normalizeEnvironment(env) {
  return (env || process.env.APPSTORE_ENVIRONMENT || 'Production').toUpperCase() === 'SANDBOX'
    ? 'SANDBOX'
    : 'PRODUCTION';
}

function host(envOverride) {
  const env = normalizeEnvironment(envOverride);
  return env === 'SANDBOX' ? HOSTS.SANDBOX : HOSTS.PRODUCTION;
}

function loadPrivateKey() {
  const inline = process.env.APPSTORE_PRIVATE_KEY;
  if (inline && inline.includes('BEGIN')) {
    return inline.replace(/\\n/g, '\n');
  }
  const path = process.env.APPSTORE_PRIVATE_KEY_PATH;
  if (path && existsSync(path)) {
    return readFileSync(path, 'utf8');
  }
  return null;
}

export function isConfigured() {
  return !!(
    process.env.APPSTORE_ISSUER_ID &&
    process.env.APPSTORE_KEY_ID &&
    process.env.APPSTORE_BUNDLE_ID &&
    loadPrivateKey()
  );
}

// ---------------------------------------------------------------
// JWT bearer token (ES256, signed with the .p8 key)
// ---------------------------------------------------------------

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

let cachedToken = null;

function generateToken() {
  if (cachedToken && cachedToken.exp > Date.now() / 1000 + 60) {
    return cachedToken.token;
  }
  if (!isConfigured()) {
    throw new Error('appstore_api_not_configured: set APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_BUNDLE_ID');
  }

  const header = {
    alg: 'ES256',
    kid: process.env.APPSTORE_KEY_ID,
    typ: 'JWT',
  };
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 20 * 60;
  const payload = {
    iss: process.env.APPSTORE_ISSUER_ID,
    iat: now,
    exp,
    aud: 'appstoreconnect-v1',
    bid: process.env.APPSTORE_BUNDLE_ID,
  };

  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const signingInput = Buffer.from(`${h}.${p}`);
  const key = crypto.createPrivateKey(loadPrivateKey());
  const der = crypto.sign('SHA256', signingInput, key);
  const raw = ecdsaDerToRaw(der);
  const token = `${h}.${p}.${b64url(raw)}`;

  cachedToken = { token, exp };
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

  // Strip leading zeroes (DER) and left-pad to 32 bytes (raw).
  while (r.length > 32 && r[0] === 0) r = r.slice(1);
  while (s.length > 32 && s[0] === 0) s = s.slice(1);
  const rPad = Buffer.concat([Buffer.alloc(32 - r.length, 0), r]);
  const sPad = Buffer.concat([Buffer.alloc(32 - s.length, 0), s]);
  return Buffer.concat([rPad, sPad]);
}

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------

async function appleRequest(method, path, { query = {}, body, environment } = {}) {
  const url = new URL(`${host(environment)}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const headers = {
    authorization: `Bearer ${generateToken()}`,
    accept: 'application/json',
  };
  if (body != null) headers['content-type'] = 'application/json';
  const res = await fetch(url, {
    method,
    headers: {
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
  if (!res.ok) {
    const err = new Error(`appstore_api_${res.status}: ${typeof parsed === 'string' ? parsed : (parsed.errorMessage || JSON.stringify(parsed))}`);
    err.status = res.status;
    err.body = parsed;
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
// Public API
// ---------------------------------------------------------------

/**
 * Get a single transaction by ID.
 * Response: { signedTransactionInfo: <JWS> }
 *
 * https://developer.apple.com/documentation/appstoreserverapi/get_transaction_info
 */
export async function getTransactionInfo(transactionId) {
  return appleGet(`/inApps/v1/transactions/${encodeURIComponent(transactionId)}`);
}

/**
 * Get a user's full transaction history (all in-app purchases — subscriptions,
 * one-time, consumable, lifetime — sorted by purchase date).
 *
 * Pass *any* transactionId belonging to that user (originalTransactionId is the
 * canonical anchor; any tx in the chain works). The API resolves the family.
 *
 * Pagination via `revision`. We loop until !hasMore and return all signedTransactions.
 *
 * https://developer.apple.com/documentation/appstoreserverapi/get_transaction_history
 *
 * @param {string} transactionId  any transactionId (originalTransactionId preferred)
 * @param {object} opts
 *   - sort: 'ASCENDING' | 'DESCENDING' (default 'ASCENDING')
 *   - productType: 'AUTO_RENEWABLE' | 'NON_RENEWABLE' | 'CONSUMABLE' | 'NON_CONSUMABLE'
 *   - startDate, endDate: ms timestamps
 *   - revoked: 'true' | 'false'
 *   - inAppOwnershipType: 'FAMILY_SHARED' | 'PURCHASED'
 *   - maxPages: safety cap (default 20 → up to 400 transactions/user)
 */
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
    }, { environment: opts.environment });

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

/**
 * Get the *current* subscription status for a user — for each subscription group,
 * the latest transaction + auto-renew info. Useful for verifying our local state.
 *
 * https://developer.apple.com/documentation/appstoreserverapi/get_all_subscription_statuses
 */
export async function getSubscriptionStatuses(transactionId, opts = {}) {
  return appleGet(`/inApps/v1/subscriptions/${encodeURIComponent(transactionId)}`, {
    status: opts.status, // optional filter
  }, { environment: opts.environment });
}

/**
 * Get refund history for a user (all refunded transactions).
 *
 * https://developer.apple.com/documentation/appstoreserverapi/get_refund_history
 */
export async function getRefundHistory(transactionId, opts = {}) {
  const all = [];
  let revision = opts.revision || null;
  let pages = 0;
  const maxPages = opts.maxPages ?? 10;

  while (true) {
    const data = await appleGet(`/inApps/v2/refund/lookup/${encodeURIComponent(transactionId)}`, {
      revision: revision || undefined,
    }, { environment: opts.environment });
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

/**
 * Ask Apple to send a signed TEST notification to your configured App Store
 * Server Notification URL.
 *
 * Environment is selected by API host:
 *  - Sandbox host => Sandbox test notification
 *  - Production host => Production test notification
 *
 * Returns: { testNotificationToken: "..." }
 */
export async function requestTestNotification({ environment } = {}) {
  return applePost('/inApps/v1/notifications/test', {}, { environment });
}

/**
 * Poll test notification result by token.
 *
 * Returns Apple's delivery result to your webhook endpoint.
 */
export async function getTestNotificationStatus(testNotificationToken, { environment } = {}) {
  return appleGet(
    `/inApps/v1/notifications/test/${encodeURIComponent(testNotificationToken)}`,
    {},
    { environment }
  );
}
