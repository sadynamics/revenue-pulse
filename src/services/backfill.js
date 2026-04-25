import { db } from '../db.js';
import { processEvent } from './events.js';
import { decodeJwsPayload, mapNotification } from './appstore.js';
import {
  getTransactionHistory,
  getSubscriptionStatuses,
  isConfigured,
} from './appstore-api.js';
import {
  getApps,
  getAppById,
  getDefaultApp,
  getAppByBundleId,
  isAppApiConfigured,
} from './apps.js';

/**
 * Backfill a single user's full purchase history from the App Store Server API.
 * Multi-app: every operation is scoped to a specific app (resolved by id, by
 * bundle_id from the transaction payload, or falling back to the default app).
 *
 * Strategy is unchanged:
 *  1. Fetch all signed transactions from Apple (paginated, ascending by date).
 *  2. Decode the JWS payload (signed by Apple — trusted).
 *  3. Synthesize an Apple notification shape and reuse `mapNotification` to convert
 *     it into our internal event model.
 *  4. Skip transactions whose `transactionId` is already ingested for this app.
 *  5. Run through `processEvent` so subscriber state, LTV, notifications, and SSE
 *     all get updated as if the events arrived live.
 */

function syntheticNotificationFor(tx) {
  if (tx.revocationDate) {
    return { notificationType: 'REFUND', subtype: null };
  }
  switch (tx.type) {
    case 'Auto-Renewable Subscription':
      if (tx.transactionReason === 'RENEWAL') {
        return { notificationType: 'DID_RENEW', subtype: null };
      }
      return { notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY' };
    case 'Non-Renewing Subscription':
    case 'Consumable':
    case 'Non-Consumable':
      return { notificationType: 'ONE_TIME_CHARGE', subtype: null };
    default:
      return { notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY' };
  }
}

function buildSyntheticNotification(tx, app) {
  const { notificationType, subtype } = syntheticNotificationFor(tx);
  // Include app id in the synthetic UUID so two apps' history backfills can
  // never collide on the events.event_id UNIQUE constraint.
  const uuid = `apple-tx-${app.id}-${tx.transactionId}`;

  return {
    notificationType,
    subtype,
    notificationUUID: uuid,
    version: '2.0',
    signedDate: tx.purchaseDate || Date.now(),
    summary: null,
    data: {
      appAppleId: null,
      bundleId: tx.bundleId || app.bundle_id,
      bundleVersion: null,
      environment: tx.environment,
      status: null,
    },
    transactionInfo: tx,
    renewalInfo: null,
  };
}

function decodeSignedTx(signedTx) {
  return decodeJwsPayload(signedTx);
}

const eventExistsByTxStmt = db.prepare(
  'SELECT 1 AS x FROM events WHERE app_id = ? AND transaction_id = ? LIMIT 1'
);

const subscriberByIdStmt = db.prepare(
  'SELECT app_id, app_user_id, original_app_user_id FROM subscribers WHERE app_id = ? AND app_user_id = ?'
);

const firstAppleEventForUserStmt = db.prepare(`
  SELECT original_transaction_id, transaction_id
  FROM events
  WHERE app_id = ? AND app_user_id = ? AND original_transaction_id IS NOT NULL
  ORDER BY event_timestamp_ms ASC
  LIMIT 1
`);

/**
 * Resolve a transaction anchor we can pass to App Store Server API for this user.
 * Prefers originalTransactionId, then transactionId, then numeric user ids.
 */
export function resolveAppleAnchorTx(appUserId, appId) {
  const id = appId || (getDefaultApp() ? getDefaultApp().id : '');
  const sub = subscriberByIdStmt.get(id, appUserId);
  if (!sub) return null;

  const row = firstAppleEventForUserStmt.get(id, appUserId);
  if (row?.original_transaction_id) return row.original_transaction_id;
  if (row?.transaction_id) return row.transaction_id;

  if (/^\d+$/.test(sub.original_app_user_id || '')) return sub.original_app_user_id;
  if (/^\d+$/.test(appUserId || '')) return appUserId;
  return null;
}

function resolveAppFromTx(tx, fallbackApp) {
  if (tx?.bundleId) {
    const byBundle = getAppByBundleId(tx.bundleId);
    if (byBundle) return byBundle;
  }
  return fallbackApp;
}

/**
 * Backfill a single user. `transactionId` may be either an originalTransactionId
 * or any transactionId in the user's family — Apple resolves the chain.
 *
 * `app` may be an app object, an app id string, or omitted (uses default).
 *
 * Returns: { fetched, inserted, skipped, errors }
 */
export async function backfillUser(transactionId, opts = {}) {
  const app = (typeof opts.app === 'object' && opts.app)
    ? opts.app
    : (opts.app ? getAppById(opts.app) : getDefaultApp());
  if (!app) throw new Error('appstore_api_no_app');
  if (!isAppApiConfigured(app)) {
    throw new Error(`appstore_api_not_configured: app "${app.id}" is missing credentials`);
  }
  if (!transactionId) throw new Error('transactionId_required');

  const signed = await getTransactionHistory(transactionId, {
    sort: 'ASCENDING',
    ...opts,
    app,
  });

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const jws of signed) {
    try {
      const tx = decodeSignedTx(jws);
      if (!tx?.transactionId) { errors++; continue; }

      // Tolerate notifications that mention a different bundle (e.g. when an
      // app id was set up for another bundleId). We trust the bundleId on the
      // transaction — but we record the event under the *app we were asked to
      // backfill*, not the bundleId-derived app, so callers stay in control.
      const targetApp = app;

      if (eventExistsByTxStmt.get(targetApp.id, tx.transactionId)) {
        skipped++;
        continue;
      }

      const synthetic = buildSyntheticNotification(tx, targetApp);
      const internal = mapNotification(synthetic, { appId: targetApp.id });
      for (const ev of internal) {
        const r = processEvent(ev);
        if (r.duplicate) skipped++; else inserted++;
      }
    } catch (err) {
      errors++;
      console.warn('[backfill] tx decode/insert failed:', err.message);
    }
  }

  return { fetched: signed.length, inserted, skipped, errors, app_id: app.id };
}

/**
 * Optional: fetch the live Apple subscription state for a user and return it
 * (without inserting). Useful for UI panels and reconciling local will_renew /
 * expiration state vs. Apple's truth.
 */
export async function fetchAppleSubscriptionState(transactionId, opts = {}) {
  const app = (typeof opts.app === 'object' && opts.app)
    ? opts.app
    : (opts.app ? getAppById(opts.app) : getDefaultApp());
  if (!app) throw new Error('appstore_api_no_app');
  if (!isAppApiConfigured(app)) {
    throw new Error(`appstore_api_not_configured: app "${app.id}" is missing credentials`);
  }
  const data = await getSubscriptionStatuses(transactionId, { ...opts, app });
  const decoded = [];
  for (const group of (data.data || [])) {
    for (const t of (group.lastTransactions || [])) {
      try {
        decoded.push({
          subscriptionGroupIdentifier: group.subscriptionGroupIdentifier,
          status: t.status,
          transaction: t.signedTransactionInfo ? decodeJwsPayload(t.signedTransactionInfo) : null,
          renewal:     t.signedRenewalInfo     ? decodeJwsPayload(t.signedRenewalInfo)     : null,
        });
      } catch (e) {
        decoded.push({ error: e.message });
      }
    }
  }
  return { environment: data.environment, app_id: app.id, statuses: decoded };
}

/**
 * Walk every distinct originalTransactionId in the events table for the given
 * app (or every configured app when `app` is omitted) and backfill each.
 * Concurrency is kept low to stay polite with Apple's rate limits.
 */
export async function backfillAll({ concurrency = 2, onProgress, app } = {}) {
  const targets = [];
  if (app) {
    const a = typeof app === 'object' ? app : getAppById(app);
    if (a) targets.push(a);
  } else {
    targets.push(...getApps().filter(isAppApiConfigured));
  }

  let totalUsers = 0;
  let totalInserted = 0;
  let totalFetched = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  const perApp = {};

  for (const targetApp of targets) {
    const ids = db
      .prepare(`
        SELECT DISTINCT original_transaction_id AS id
        FROM events
        WHERE app_id = ?
          AND original_transaction_id IS NOT NULL AND original_transaction_id != ''
      `)
      .all(targetApp.id)
      .map(r => r.id);

    let inserted = 0, fetched = 0, skipped = 0, errors = 0, processed = 0;

    let cursor = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (cursor < ids.length) {
        const i = cursor++;
        const id = ids[i];
        try {
          const r = await backfillUser(id, { app: targetApp });
          fetched += r.fetched;
          inserted += r.inserted;
          skipped += r.skipped;
          errors += r.errors;
        } catch (err) {
          errors++;
          console.warn(`[backfill] app=${targetApp.id} user=${id} failed:`, err.message);
        } finally {
          processed++;
          if (onProgress) onProgress({
            app_id: targetApp.id,
            processed, total: ids.length, currentUser: id,
          });
        }
      }
    });
    await Promise.all(workers);

    perApp[targetApp.id] = { users: ids.length, fetched, inserted, skipped, errors };
    totalUsers += ids.length;
    totalFetched += fetched;
    totalInserted += inserted;
    totalSkipped += skipped;
    totalErrors += errors;
  }

  return {
    users: totalUsers,
    fetched: totalFetched,
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: totalErrors,
    apps: perApp,
  };
}

// ---------------------------------------------------------------
// Auto-trigger on first sighting of a new originalTransactionId
// ---------------------------------------------------------------

const seenOriginalTxStmt = db.prepare(
  `SELECT COUNT(*) AS c FROM events WHERE app_id = ? AND original_transaction_id = ?`
);

const inFlight = new Set();

/**
 * Fire-and-forget: if we just received the *first* event for a given Apple
 * user (within `app`), pull their full history from Apple in the background.
 * The webhook responds 200 immediately to Apple either way.
 */
export function maybeBackfillInBackground(originalTransactionId, justInsertedCount, app) {
  if (!originalTransactionId) return;
  const targetApp = (typeof app === 'object' && app) ? app : (app ? getAppById(app) : getDefaultApp());
  if (!targetApp || !isAppApiConfigured(targetApp)) return;

  const key = `${targetApp.id}:${originalTransactionId}`;
  if (inFlight.has(key)) return;

  const { c } = seenOriginalTxStmt.get(targetApp.id, originalTransactionId);
  if (c > justInsertedCount) return;

  inFlight.add(key);
  setImmediate(async () => {
    try {
      const r = await backfillUser(originalTransactionId, { app: targetApp });
      console.log(`[backfill:auto] app=${targetApp.id} otid=${originalTransactionId} fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} errors=${r.errors}`);
    } catch (err) {
      console.warn(`[backfill:auto] app=${targetApp.id} otid=${originalTransactionId} failed: ${err.message}`);
    } finally {
      inFlight.delete(key);
    }
  });
}
