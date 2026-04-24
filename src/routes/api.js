import { Router } from 'express';
import { db } from '../db.js';
import * as analytics from '../services/analytics.js';
import {
  backfillUser,
  fetchAppleSubscriptionState,
} from '../services/backfill.js';
import { isConfigured as appstoreApiConfigured } from '../services/appstore-api.js';

export const api = Router();

api.get('/config', (req, res) => {
  res.json({
    appstore_api_configured: appstoreApiConfigured(),
    environment: process.env.APPSTORE_ENVIRONMENT || 'Production',
    bundle_id: process.env.APPSTORE_BUNDLE_ID || null,
  });
});

api.get('/metrics', (req, res) => {
  res.json(analytics.kpis());
});

api.get('/daily', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  res.json(analytics.daily(days));
});

api.get('/mrr-history', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  res.json(analytics.mrrHistory(days));
});

api.get('/products', (req, res) => res.json(analytics.productBreakdown()));
api.get('/countries', (req, res) => res.json(analytics.countryBreakdown()));
api.get('/stores', (req, res) => res.json(analytics.storeBreakdown()));
api.get('/churn-reasons', (req, res) => res.json(analytics.churnReasons()));
api.get('/top-subscribers', (req, res) => res.json(analytics.topSubscribers(20)));
api.get('/upcoming-renewals', (req, res) => res.json(analytics.upcomingRenewals()));

api.get('/subscribers', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const status = req.query.status;
  const q = req.query.q;
  const product = req.query.product;

  const where = [];
  const params = {};
  if (status && status !== 'all') { where.push('status = @status'); params.status = status; }
  if (product) { where.push('current_product_id = @product'); params.product = product; }
  if (q) { where.push('(app_user_id LIKE @q OR original_app_user_id LIKE @q)'); params.q = `%${q}%`; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM subscribers ${whereSql}`).get(params).c;
  const rows = db.prepare(`
    SELECT * FROM subscribers
    ${whereSql}
    ORDER BY last_event_ms DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  res.json({ total, items: rows });
});

api.get('/subscribers/:id', (req, res) => {
  const sub = db.prepare('SELECT * FROM subscribers WHERE app_user_id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'not_found' });

  const events = db.prepare(`
    SELECT * FROM events
    WHERE app_user_id = ?
    ORDER BY event_timestamp_ms DESC
    LIMIT 200
  `).all(req.params.id);

  res.json({ subscriber: sub, events });
});

/** Resolve a transactionId we can give to the App Store Server API for this user. */
function appleAnchorTxFor(appUserId) {
  const sub = db.prepare(
    'SELECT app_user_id, original_app_user_id FROM subscribers WHERE app_user_id = ?'
  ).get(appUserId);
  if (!sub) return null;

  // Prefer an explicit Apple originalTransactionId from any event row.
  const row = db.prepare(`
    SELECT original_transaction_id, transaction_id
    FROM events
    WHERE app_user_id = ? AND original_transaction_id IS NOT NULL
    ORDER BY event_timestamp_ms ASC
    LIMIT 1
  `).get(appUserId);
  if (row?.original_transaction_id) return row.original_transaction_id;
  if (row?.transaction_id) return row.transaction_id;

  // Falls back to the user id itself if it looks numeric (Apple OTIDs are numeric strings).
  if (/^\d+$/.test(sub.original_app_user_id || '')) return sub.original_app_user_id;
  if (/^\d+$/.test(appUserId)) return appUserId;
  return null;
}

/**
 * Pull the full transaction history for a single subscriber from Apple and
 * merge it into our DB. Idempotent — replays existing transactions are skipped.
 */
api.post('/subscribers/:id/sync', async (req, res) => {
  if (!appstoreApiConfigured()) {
    return res.status(400).json({
      error: 'appstore_api_not_configured',
      message: 'Set APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH] and APPSTORE_BUNDLE_ID.',
    });
  }
  const anchor = req.body?.transactionId || appleAnchorTxFor(req.params.id);
  if (!anchor) {
    return res.status(400).json({
      error: 'no_anchor_transaction',
      message: 'Could not find an Apple transaction ID for this user. Pass { transactionId } in the body.',
    });
  }
  try {
    const result = await backfillUser(anchor);
    res.json({ ok: true, anchor, ...result });
  } catch (err) {
    console.error('[api] sync failed:', err.message);
    res.status(err.status || 500).json({ error: 'sync_failed', message: err.message });
  }
});

/** Live Apple subscription status (autoRenewStatus, expiresDate, product, etc). */
api.get('/subscribers/:id/apple-status', async (req, res) => {
  if (!appstoreApiConfigured()) {
    return res.status(400).json({ error: 'appstore_api_not_configured' });
  }
  const anchor = appleAnchorTxFor(req.params.id);
  if (!anchor) return res.status(400).json({ error: 'no_anchor_transaction' });
  try {
    const data = await fetchAppleSubscriptionState(anchor);
    res.json({ anchor, ...data });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'apple_status_failed', message: err.message });
  }
});

api.get('/events', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const type = req.query.type;
  const product = req.query.product;

  const where = [];
  const params = {};
  if (type && type !== 'all') { where.push('type = @type'); params.type = type; }
  if (product) { where.push('product_id = @product'); params.product = product; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM events ${whereSql}`).get(params).c;
  const rows = db.prepare(`
    SELECT id, event_id, type, app_user_id, product_id, period_type, price, price_usd, currency,
           country_code, store, environment, event_timestamp_ms, expiration_at_ms, cancel_reason, expiration_reason
    FROM events ${whereSql}
    ORDER BY event_timestamp_ms DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset });

  res.json({ total, items: rows });
});

api.get('/events/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  try { row.raw_json = JSON.parse(row.raw_json); } catch (_) {}
  try { row.entitlement_ids = JSON.parse(row.entitlement_ids); } catch (_) {}
  try { row.aliases = JSON.parse(row.aliases); } catch (_) {}
  res.json(row);
});

api.get('/notifications', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const rows = db.prepare(`
    SELECT * FROM notifications ORDER BY created_at_ms DESC LIMIT ?
  `).all(limit);
  res.json(rows);
});

/** Renewals özel endpoint: sadece RENEWAL event'leri. */
api.get('/renewals', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const rows = db.prepare(`
    SELECT id, app_user_id, product_id, period_type, price, price_usd, currency, country_code,
           store, event_timestamp_ms, expiration_at_ms
    FROM events WHERE type = 'RENEWAL'
    ORDER BY event_timestamp_ms DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'RENEWAL'`).get().c;
  res.json({ total, items: rows });
});

api.get('/summary', (req, res) => {
  res.json({
    kpis: analytics.kpis(),
    daily: analytics.daily(30),
    mrr_history: analytics.mrrHistory(30),
    products: analytics.productBreakdown().slice(0, 10),
    countries: analytics.countryBreakdown().slice(0, 10),
    churn_reasons: analytics.churnReasons(90).slice(0, 10),
    top_subscribers: analytics.topSubscribers(10),
    upcoming_renewals: analytics.upcomingRenewals(168).slice(0, 10),
  });
});
