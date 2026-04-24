import { db } from '../db.js';
import { mapNotification, decodeJwsPayload } from './appstore.js';
import { processEvent } from './events.js';
import {
  getRefundHistory,
  isConfigured as appstoreConfigured,
} from './appstore-api.js';
import {
  fetchAppleSubscriptionState,
  resolveAppleAnchorTx,
} from './backfill.js';

const existingTxStmt = db.prepare('SELECT 1 AS x FROM events WHERE transaction_id = ? LIMIT 1');
const activeSubscribersStmt = db.prepare(`
  SELECT app_user_id, status, will_renew, expiration_ms, current_product_id
  FROM subscribers
  WHERE status IN ('active', 'paused', 'billing_issue')
  ORDER BY last_event_ms DESC
  LIMIT ?
`);

function buildSyntheticDecoded({ notificationType, subtype = null, tx = null, renewal = null, environment = 'PRODUCTION' }) {
  const seed = tx?.transactionId || tx?.originalTransactionId || cryptoRandomId();
  return {
    notificationType,
    subtype,
    notificationUUID: `reconcile-${notificationType.toLowerCase()}-${seed}-${Date.now()}`,
    version: '2.0',
    signedDate: Date.now(),
    data: {
      bundleId: tx?.bundleId || process.env.APPSTORE_BUNDLE_ID || null,
      environment,
    },
    transactionInfo: tx,
    renewalInfo: renewal,
  };
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2, 12);
}

function ingestSynthetic(decoded) {
  const internal = mapNotification(decoded);
  let inserted = 0;
  let skipped = 0;
  for (const ev of internal) {
    const r = processEvent(ev);
    if (r.duplicate) skipped++;
    else inserted++;
  }
  return { inserted, skipped };
}

export function summarizeAppleStatus(appleStatuses = []) {
  let latestTx = null;
  let latestRenewal = null;
  let latestExpiresMs = null;
  let autoRenewStatus = null;
  let environment = null;

  for (const row of appleStatuses) {
    const tx = row.transaction || null;
    const renewal = row.renewal || null;
    const expires = tx?.expiresDate || null;
    if (expires && (!latestExpiresMs || expires > latestExpiresMs)) {
      latestExpiresMs = expires;
      latestTx = tx;
      latestRenewal = renewal;
      autoRenewStatus = renewal?.autoRenewStatus ?? null;
      environment = tx?.environment || renewal?.environment || environment;
    }
  }

  return {
    latestTx,
    latestRenewal,
    latestExpiresMs,
    autoRenewStatus,
    environment: (environment || 'PRODUCTION').toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
  };
}

export function computeDrift(subscriber, appleStatuses = []) {
  const now = Date.now();
  const s = summarizeAppleStatus(appleStatuses);
  const issues = [];

  const hasAppleExpiry = !!s.latestExpiresMs;
  const hasLocalExpiry = !!subscriber.expiration_ms;
  const expiryDiffMs = hasAppleExpiry && hasLocalExpiry
    ? Math.abs(s.latestExpiresMs - subscriber.expiration_ms)
    : null;

  if (hasAppleExpiry && hasLocalExpiry && expiryDiffMs > 5 * 60 * 1000) {
    issues.push({
      code: 'EXPIRATION_MISMATCH',
      severity: 'warning',
      message: `Local expiry ${new Date(subscriber.expiration_ms).toISOString()} differs from Apple ${new Date(s.latestExpiresMs).toISOString()}.`,
    });
  } else if (hasAppleExpiry && !hasLocalExpiry) {
    issues.push({
      code: 'LOCAL_EXPIRY_MISSING',
      severity: 'warning',
      message: 'Apple has an expiry date but local subscriber.expiration_ms is empty.',
    });
  }

  if (s.autoRenewStatus != null) {
    const appleWillRenew = s.autoRenewStatus === 1;
    if (appleWillRenew !== !!subscriber.will_renew) {
      issues.push({
        code: 'WILL_RENEW_MISMATCH',
        severity: 'warning',
        message: `Local will_renew=${subscriber.will_renew} but Apple autoRenewStatus=${s.autoRenewStatus}.`,
      });
    }
  }

  if (s.latestExpiresMs && s.latestExpiresMs < now && subscriber.status !== 'expired') {
    issues.push({
      code: 'SHOULD_BE_EXPIRED',
      severity: 'danger',
      message: 'Apple indicates subscription is expired, but local status is not expired.',
    });
  }

  return {
    local: {
      status: subscriber.status,
      will_renew: !!subscriber.will_renew,
      expiration_ms: subscriber.expiration_ms || null,
      product_id: subscriber.current_product_id || null,
    },
    apple: {
      environment: s.environment,
      auto_renew_status: s.autoRenewStatus,
      will_renew: s.autoRenewStatus == null ? null : s.autoRenewStatus === 1,
      expiration_ms: s.latestExpiresMs || null,
      product_id: s.latestTx?.productId || null,
    },
    drift: {
      has_drift: issues.length > 0,
      issues,
      expiration_diff_ms: expiryDiffMs,
    },
    latest: s,
  };
}

async function repairSubscriptionDrift(subscriber, driftResult) {
  const now = Date.now();
  const latestTx = driftResult.latest.latestTx;
  const latestRenewal = driftResult.latest.latestRenewal;
  const env = driftResult.apple.environment || 'PRODUCTION';

  let inserted = 0;
  let skipped = 0;
  const applied = [];

  if (driftResult.apple.expiration_ms && driftResult.apple.expiration_ms < now && subscriber.status !== 'expired') {
    const out = ingestSynthetic(buildSyntheticDecoded({
      notificationType: 'EXPIRED',
      subtype: 'VOLUNTARY',
      tx: latestTx,
      renewal: latestRenewal,
      environment: env,
    }));
    inserted += out.inserted;
    skipped += out.skipped;
    if (out.inserted) applied.push('EXPIRATION');
  }

  if (driftResult.apple.will_renew === false && subscriber.will_renew) {
    const out = ingestSynthetic(buildSyntheticDecoded({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_DISABLED',
      tx: latestTx,
      renewal: latestRenewal || { autoRenewStatus: 0, productId: latestTx?.productId, originalTransactionId: latestTx?.originalTransactionId },
      environment: env,
    }));
    inserted += out.inserted;
    skipped += out.skipped;
    if (out.inserted) applied.push('CANCELLATION');
  }

  if (driftResult.apple.will_renew === true && !subscriber.will_renew && (!driftResult.apple.expiration_ms || driftResult.apple.expiration_ms > now)) {
    const out = ingestSynthetic(buildSyntheticDecoded({
      notificationType: 'DID_CHANGE_RENEWAL_STATUS',
      subtype: 'AUTO_RENEW_ENABLED',
      tx: latestTx,
      renewal: latestRenewal || { autoRenewStatus: 1, productId: latestTx?.productId, originalTransactionId: latestTx?.originalTransactionId },
      environment: env,
    }));
    inserted += out.inserted;
    skipped += out.skipped;
    if (out.inserted) applied.push('UNCANCELLATION');
  }

  return { inserted, skipped, applied };
}

async function reconcileMissingRefunds(anchorTx, environment) {
  const signed = await getRefundHistory(anchorTx, { environment });
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (const jws of signed) {
    try {
      const tx = decodeJwsPayload(jws);
      if (!tx?.transactionId) {
        errors++;
        continue;
      }
      if (existingTxStmt.get(tx.transactionId)) {
        skipped++;
        continue;
      }
      const txForRefund = {
        ...tx,
        revocationDate: tx.revocationDate || tx.signedDate || Date.now(),
      };
      const out = ingestSynthetic(buildSyntheticDecoded({
        notificationType: 'REFUND',
        tx: txForRefund,
        environment: (tx.environment || environment || 'PRODUCTION'),
      }));
      inserted += out.inserted;
      skipped += out.skipped;
    } catch (err) {
      errors++;
    }
  }
  return { fetched: signed.length, inserted, skipped, errors };
}

export async function reconcileUser(appUserId, { environment, repair = true } = {}) {
  const subscriber = db.prepare(
    'SELECT app_user_id, status, will_renew, expiration_ms, current_product_id FROM subscribers WHERE app_user_id = ?'
  ).get(appUserId);
  if (!subscriber) {
    return { ok: false, app_user_id: appUserId, reason: 'not_found' };
  }
  const anchor = resolveAppleAnchorTx(appUserId);
  if (!anchor) {
    return { ok: false, app_user_id: appUserId, reason: 'no_anchor_transaction' };
  }

  const apple = await fetchAppleSubscriptionState(anchor, { environment });
  const drift = computeDrift(subscriber, apple.statuses || []);
  const repairResult = repair ? await repairSubscriptionDrift(subscriber, drift) : { inserted: 0, skipped: 0, applied: [] };
  const refunds = await reconcileMissingRefunds(anchor, environment);

  return {
    ok: true,
    app_user_id: appUserId,
    anchor,
    drift: drift.drift,
    apple: drift.apple,
    repairs: repairResult,
    refunds,
  };
}

const reconcileState = {
  running: false,
  last_started_at: null,
  last_finished_at: null,
  last_result: null,
  last_error: null,
};

export function getReconcileState() {
  return { ...reconcileState };
}

export async function runReconcile({ limit = 200, repair = true, environment } = {}) {
  if (!appstoreConfigured()) throw new Error('appstore_api_not_configured');
  if (reconcileState.running) throw new Error('reconcile_already_running');

  reconcileState.running = true;
  reconcileState.last_started_at = Date.now();
  reconcileState.last_error = null;

  try {
    const candidates = activeSubscribersStmt.all(limit);
    const summary = {
      users: candidates.length,
      checked: 0,
      drifted: 0,
      repaired_events: 0,
      refund_events: 0,
      errors: 0,
      started_at: reconcileState.last_started_at,
      finished_at: null,
    };

    for (const c of candidates) {
      try {
        const out = await reconcileUser(c.app_user_id, { environment, repair });
        summary.checked++;
        if (out.ok && out.drift?.has_drift) summary.drifted++;
        summary.repaired_events += out.repairs?.inserted || 0;
        summary.refund_events += out.refunds?.inserted || 0;
      } catch (err) {
        summary.errors++;
      }
    }
    summary.finished_at = Date.now();
    reconcileState.last_finished_at = summary.finished_at;
    reconcileState.last_result = summary;
    return summary;
  } catch (err) {
    reconcileState.last_error = err.message;
    throw err;
  } finally {
    reconcileState.running = false;
  }
}

export function startReconcileScheduler() {
  const enabled = !/^(0|false|no)$/i.test(process.env.APPSTORE_RECONCILE_ENABLED || 'true');
  if (!enabled) return null;

  const hours = Math.max(1, Number(process.env.APPSTORE_RECONCILE_INTERVAL_HOURS || 24));
  const limit = Math.max(1, Number(process.env.APPSTORE_RECONCILE_BATCH_LIMIT || 200));
  const intervalMs = hours * 60 * 60 * 1000;

  const tick = async () => {
    if (!appstoreConfigured()) return;
    try {
      const result = await runReconcile({ limit, repair: true });
      console.log(
        `[reconcile] users=${result.users} checked=${result.checked} drifted=${result.drifted} repaired=${result.repaired_events} refunds=${result.refund_events} errors=${result.errors}`
      );
    } catch (err) {
      if (err.message !== 'reconcile_already_running') {
        console.warn('[reconcile] failed:', err.message);
      }
    }
  };

  setTimeout(() => void tick(), 20_000);
  const timer = setInterval(() => void tick(), intervalMs);
  console.log(`[reconcile] scheduler enabled: every ${hours}h, batch_limit=${limit}`);
  return timer;
}
