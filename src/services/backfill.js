import { db } from '../db.js';
import { processEvent } from './events.js';
import { decodeJwsPayload, mapNotification } from './appstore.js';
import {
  getTransactionHistory,
  getSubscriptionStatuses,
  isConfigured,
} from './appstore-api.js';

/**
 * Backfill a single user's full purchase history from the App Store Server API.
 *
 * Strategy:
 *  1. Fetch all signed transactions from Apple (paginated, ascending by date).
 *  2. For each one, decode the JWS payload (it's signed by Apple so we trust it).
 *  3. Synthesize an Apple notification shape and reuse `mapNotification` to convert
 *     it into our internal event model.
 *  4. Skip transactions whose `transactionId` is already ingested (idempotent).
 *  5. Run through `processEvent` so subscriber state, LTV, notifications, and SSE
 *     all get updated as if the events arrived live.
 *
 * The same one function handles auto-renewable, non-renewing, consumable, and
 * non-consumable (lifetime) purchases — the unified API endpoint returns all of
 * them, and our existing mapping in appstore.js already supports each type.
 */

/**
 * Map an Apple transactionType + revocation state to a synthetic notificationType
 * so we can pipe history transactions through `mapNotification` unchanged.
 *
 * Reference (transaction.type field):
 *   "Auto-Renewable Subscription" | "Non-Renewing Subscription"
 *   | "Non-Consumable" | "Consumable"
 *
 * Reference (transactionReason — only present for auto-renewable):
 *   "PURCHASE" | "RENEWAL"
 */
function syntheticNotificationFor(tx) {
  // Refunded transactions → REFUND event (revocationDate is set when Apple refunded)
  if (tx.revocationDate) {
    return { notificationType: 'REFUND', subtype: null };
  }

  switch (tx.type) {
    case 'Auto-Renewable Subscription':
      if (tx.transactionReason === 'RENEWAL') {
        return { notificationType: 'DID_RENEW', subtype: null };
      }
      // First purchase or resubscribe — both look like INITIAL_BUY for our purposes.
      return { notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY' };

    case 'Non-Renewing Subscription':
    case 'Consumable':
    case 'Non-Consumable':
      // Apple ships ONE_TIME_CHARGE notifications for these starting iOS 17.
      // For history-only transactions we synthesize the same type.
      return { notificationType: 'ONE_TIME_CHARGE', subtype: null };

    default:
      // Fallback — treat as initial purchase
      return { notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY' };
  }
}

/**
 * Build a decoded-notification-shaped object so it can flow through `mapNotification`.
 * Note: the `raw_json` recorded for these synthetic events is the actual transaction
 * payload from Apple, so it's still fully traceable in /api/events/:id.
 */
function buildSyntheticNotification(tx) {
  const { notificationType, subtype } = syntheticNotificationFor(tx);
  const uuid = `apple-tx-${tx.transactionId}`;

  return {
    notificationType,
    subtype,
    notificationUUID: uuid,
    version: '2.0',
    signedDate: tx.purchaseDate || Date.now(),
    summary: null,
    data: {
      appAppleId: null,
      bundleId: tx.bundleId,
      bundleVersion: null,
      environment: tx.environment,
      status: null,
    },
    transactionInfo: tx,
    renewalInfo: null,
  };
}

/**
 * Decode a JWS-signed transaction returned by the App Store Server API.
 * We trust Apple's signatures here (they sign the same way as in notifications).
 * If you want belt-and-suspenders, call verifyJws() instead.
 */
function decodeSignedTx(signedTx) {
  return decodeJwsPayload(signedTx);
}

const eventExistsByTxStmt = db.prepare(
  'SELECT 1 AS x FROM events WHERE transaction_id = ? LIMIT 1'
);

const subscriberByIdStmt = db.prepare(
  'SELECT app_user_id, original_app_user_id FROM subscribers WHERE app_user_id = ?'
);
const firstAppleEventForUserStmt = db.prepare(`
  SELECT original_transaction_id, transaction_id
  FROM events
  WHERE app_user_id = ? AND original_transaction_id IS NOT NULL
  ORDER BY event_timestamp_ms ASC
  LIMIT 1
`);

/**
 * Resolve a transaction anchor we can pass to App Store Server API for this user.
 * Prefers originalTransactionId, then transactionId, then numeric user ids.
 */
export function resolveAppleAnchorTx(appUserId) {
  const sub = subscriberByIdStmt.get(appUserId);
  if (!sub) return null;

  const row = firstAppleEventForUserStmt.get(appUserId);
  if (row?.original_transaction_id) return row.original_transaction_id;
  if (row?.transaction_id) return row.transaction_id;

  if (/^\d+$/.test(sub.original_app_user_id || '')) return sub.original_app_user_id;
  if (/^\d+$/.test(appUserId || '')) return appUserId;
  return null;
}

/**
 * Backfill a single user. `transactionId` may be either an originalTransactionId
 * or any transactionId in the user's family — Apple resolves the chain.
 *
 * Returns: { fetched, inserted, skipped, errors }
 */
export async function backfillUser(transactionId, opts = {}) {
  if (!isConfigured()) {
    throw new Error('appstore_api_not_configured');
  }
  if (!transactionId) throw new Error('transactionId_required');

  const signed = await getTransactionHistory(transactionId, {
    sort: 'ASCENDING',
    ...opts,
  });

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const jws of signed) {
    try {
      const tx = decodeSignedTx(jws);
      if (!tx?.transactionId) { errors++; continue; }

      // Skip if we already have this exact transaction ingested
      // (whether it came from a webhook or a previous backfill).
      const existing = eventExistsByTxStmt.get(tx.transactionId);
      if (existing) { skipped++; continue; }

      const synthetic = buildSyntheticNotification(tx);
      const internal = mapNotification(synthetic);
      for (const ev of internal) {
        const r = processEvent(ev);
        if (r.duplicate) skipped++; else inserted++;
      }
    } catch (err) {
      errors++;
      console.warn('[backfill] tx decode/insert failed:', err.message);
    }
  }

  return { fetched: signed.length, inserted, skipped, errors };
}

/**
 * Optional: fetch the live Apple subscription state for a user and return it
 * (without inserting). Useful for UI panels and reconciling local will_renew /
 * expiration state vs. Apple's truth.
 */
export async function fetchAppleSubscriptionState(transactionId, opts = {}) {
  if (!isConfigured()) throw new Error('appstore_api_not_configured');
  const data = await getSubscriptionStatuses(transactionId, opts);
  // Decode the signed transaction + renewal info on each status entry so the
  // dashboard can show product, expiry, autoRenewStatus, etc. without a second
  // round of decoding work in the frontend.
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
  return { environment: data.environment, statuses: decoded };
}

/**
 * Walk every distinct originalTransactionId currently in the events table and
 * backfill each. Concurrency is kept low to stay polite with Apple's rate
 * limits (≈50 req/sec/org but often lower on sandbox).
 */
export async function backfillAll({ concurrency = 2, onProgress } = {}) {
  const ids = db
    .prepare(`
      SELECT DISTINCT original_transaction_id AS id
      FROM events
      WHERE original_transaction_id IS NOT NULL AND original_transaction_id != ''
    `)
    .all()
    .map(r => r.id);

  let totalInserted = 0;
  let totalFetched = 0;
  let totalSkipped = 0;
  let totalErrors = 0;
  let processed = 0;

  // Simple bounded concurrency without external deps
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < ids.length) {
      const i = cursor++;
      const id = ids[i];
      try {
        const r = await backfillUser(id);
        totalFetched += r.fetched;
        totalInserted += r.inserted;
        totalSkipped += r.skipped;
        totalErrors += r.errors;
      } catch (err) {
        totalErrors++;
        console.warn(`[backfill] user ${id} failed:`, err.message);
      } finally {
        processed++;
        if (onProgress) onProgress({ processed, total: ids.length, currentUser: id });
      }
    }
  });
  await Promise.all(workers);

  return {
    users: ids.length,
    fetched: totalFetched,
    inserted: totalInserted,
    skipped: totalSkipped,
    errors: totalErrors,
  };
}

// ---------------------------------------------------------------
// Auto-trigger on first sighting of a new originalTransactionId
// ---------------------------------------------------------------

const seenOriginalTxStmt = db.prepare(
  `SELECT COUNT(*) AS c FROM events WHERE original_transaction_id = ?`
);

const inFlight = new Set();

/**
 * Fire-and-forget: if we just received the *first* event for a given Apple user,
 * pull their full history from Apple in the background. The webhook responds
 * 200 immediately to Apple either way.
 *
 * Called from the webhook route after each successfully-ingested event.
 */
export function maybeBackfillInBackground(originalTransactionId, justInsertedCount) {
  if (!originalTransactionId) return;
  if (!isConfigured()) return;
  if (inFlight.has(originalTransactionId)) return;

  // The just-ingested event itself is in the events table now, so a "new user"
  // will have exactly `justInsertedCount` rows for this OTID.
  const { c } = seenOriginalTxStmt.get(originalTransactionId);
  if (c > justInsertedCount) return;

  inFlight.add(originalTransactionId);
  setImmediate(async () => {
    try {
      const r = await backfillUser(originalTransactionId);
      console.log(`[backfill:auto] otid=${originalTransactionId} fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} errors=${r.errors}`);
    } catch (err) {
      console.warn(`[backfill:auto] otid=${originalTransactionId} failed: ${err.message}`);
    } finally {
      inFlight.delete(originalTransactionId);
    }
  });
}
