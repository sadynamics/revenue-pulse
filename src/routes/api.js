import { Router } from 'express';
import { db } from '../db.js';
import * as analytics from '../services/analytics.js';
import {
  backfillUser,
  fetchAppleSubscriptionState,
  resolveAppleAnchorTx,
  backfillAll,
} from '../services/backfill.js';
import {
  isConfigured as appstoreApiConfigured,
  requestTestNotification,
  getTestNotificationStatus,
} from '../services/appstore-api.js';
import {
  computeDrift,
  runReconcile,
  getReconcileState,
} from '../services/reconcile.js';
import {
  getApps,
  getAppById,
  getDefaultApp,
  isAppApiConfigured,
  publicApp,
} from '../services/apps.js';
import {
  sendBootPing as notifySendPing,
  sendDailyDigestNow as notifySendDigest,
} from '../services/notify/index.js';
import { configStatus as notifyTelegramStatus } from '../services/notify/telegram.js';

export const api = Router();

/** Resolve which app the request targets — query/body `app_id`, or default. */
function pickApp(req) {
  const id = req.query?.app_id || req.body?.app_id || null;
  if (!id) return null;
  const app = getAppById(id);
  return app || null;
}

/** Like pickApp, but falls back to the default app instead of null. */
function pickAppOrDefault(req) {
  return pickApp(req) || getDefaultApp();
}

/** Validates that an `app_id` resolves; otherwise 404. */
function requireApp(req, res) {
  const app = pickApp(req);
  if (!app) {
    res.status(400).json({ error: 'app_id_required_or_invalid', valid_ids: getApps().map(a => a.id) });
    return null;
  }
  return app;
}

api.get('/apps', (req, res) => {
  res.json({
    apps: getApps().map(publicApp),
    default_app_id: getDefaultApp()?.id || null,
  });
});

api.get('/config', (req, res) => {
  const app = pickAppOrDefault(req);
  res.json({
    apps: getApps().map(publicApp),
    default_app_id: getDefaultApp()?.id || null,
    selected_app_id: app?.id || null,
    appstore_api_configured: !!app && isAppApiConfigured(app),
    environment: app?.environment || 'Production',
    bundle_id: app?.bundle_id || null,
    reconcile: {
      enabled: !/^(0|false|no)$/i.test(process.env.APPSTORE_RECONCILE_ENABLED || 'true'),
      interval_hours: Number(process.env.APPSTORE_RECONCILE_INTERVAL_HOURS || 24),
      batch_limit: Number(process.env.APPSTORE_RECONCILE_BATCH_LIMIT || 200),
    },
  });
});

api.get('/metrics', (req, res) => {
  const app = pickApp(req);
  res.json(analytics.kpis(app?.id || null));
});

api.get('/daily', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const app = pickApp(req);
  res.json(analytics.daily(days, app?.id || null));
});

/**
 * Per-app daily revenue breakdown — used by the Overview "Daily breakdown"
 * card to render a side-by-side per-app comparison table when no single app
 * is selected. Always returns all configured apps as columns.
 */
api.get('/daily-by-app', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  res.json(analytics.dailyByApp(days));
});

api.get('/mrr-history', (req, res) => {
  const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
  const app = pickApp(req);
  res.json(analytics.mrrHistory(days, app?.id || null));
});

api.get('/products', (req, res) => res.json(analytics.productBreakdown(pickApp(req)?.id || null)));
api.get('/countries', (req, res) => res.json(analytics.countryBreakdown(pickApp(req)?.id || null)));
api.get('/stores', (req, res) => res.json(analytics.storeBreakdown(pickApp(req)?.id || null)));
api.get('/churn-reasons', (req, res) => res.json(analytics.churnReasons(90, pickApp(req)?.id || null)));
api.get('/top-subscribers', (req, res) => res.json(analytics.topSubscribers(20, pickApp(req)?.id || null)));
api.get('/upcoming-renewals', (req, res) => res.json(analytics.upcomingRenewals(168, pickApp(req)?.id || null)));

api.get('/subscribers', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const status = req.query.status;
  const q = req.query.q;
  const product = req.query.product;
  const app = pickApp(req);

  const where = [];
  const params = {};
  if (app) { where.push('app_id = @app_id'); params.app_id = app.id; }
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
  const app = pickAppOrDefault(req);
  if (!app) return res.status(400).json({ error: 'no_app_configured' });

  const sub = db.prepare(
    'SELECT * FROM subscribers WHERE app_id = ? AND app_user_id = ?'
  ).get(app.id, req.params.id);
  if (!sub) return res.status(404).json({ error: 'not_found', app_id: app.id });

  const events = db.prepare(`
    SELECT * FROM events
    WHERE app_id = ? AND app_user_id = ?
    ORDER BY event_timestamp_ms DESC
    LIMIT 200
  `).all(app.id, req.params.id);

  res.json({ subscriber: sub, events });
});

/**
 * Pull the full transaction history for a single subscriber from Apple and
 * merge it into our DB. Idempotent — replays existing transactions are skipped.
 */
api.post('/subscribers/:id/sync', async (req, res) => {
  const app = pickAppOrDefault(req);
  if (!app) {
    return res.status(400).json({ error: 'no_app_configured' });
  }
  if (!isAppApiConfigured(app)) {
    return res.status(400).json({
      error: 'appstore_api_not_configured',
      app_id: app.id,
      message: `Set issuer_id, key_id, private_key for app "${app.id}" (via APPS_CONFIG or legacy APPSTORE_* env vars).`,
    });
  }
  const anchor = req.body?.transactionId || resolveAppleAnchorTx(req.params.id, app.id);
  if (!anchor) {
    return res.status(400).json({
      error: 'no_anchor_transaction',
      app_id: app.id,
      message: 'Could not find an Apple transaction ID for this user. Pass { transactionId } in the body.',
    });
  }
  try {
    const result = await backfillUser(anchor, { app });
    res.json({ ok: true, anchor, app_id: app.id, ...result });
  } catch (err) {
    console.error('[api] sync failed:', err.message);
    res.status(err.status || 500).json({ error: 'sync_failed', message: err.message });
  }
});

/** Live Apple subscription status. */
api.get('/subscribers/:id/apple-status', async (req, res) => {
  const app = pickAppOrDefault(req);
  if (!app) return res.status(400).json({ error: 'no_app_configured' });
  if (!isAppApiConfigured(app)) {
    return res.status(400).json({ error: 'appstore_api_not_configured', app_id: app.id });
  }
  const anchor = resolveAppleAnchorTx(req.params.id, app.id);
  if (!anchor) return res.status(400).json({ error: 'no_anchor_transaction', app_id: app.id });
  try {
    const subscriber = db.prepare(
      'SELECT app_id, app_user_id, status, will_renew, expiration_ms, current_product_id FROM subscribers WHERE app_id = ? AND app_user_id = ?'
    ).get(app.id, req.params.id);
    if (!subscriber) return res.status(404).json({ error: 'not_found', app_id: app.id });
    const data = await fetchAppleSubscriptionState(anchor, { app, environment: req.query.environment });
    const drift = computeDrift(subscriber, data.statuses || []);
    res.json({
      app_id: app.id,
      anchor,
      environment: data.environment,
      statuses: data.statuses,
      local: drift.local,
      apple: drift.apple,
      drift: drift.drift,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'apple_status_failed', message: err.message });
  }
});

/** Backfill all users — for the selected app, or for every configured app. */
api.post('/backfill/run', async (req, res) => {
  const app = pickApp(req); // null → all apps
  try {
    const result = await backfillAll({ concurrency: 2, app: app || undefined });
    res.json({ ok: true, app_id: app?.id || null, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'backfill_failed', message: err.message });
  }
});

/**
 * Trigger App Store "send test notification" call.
 * Routes to a specific app (defaults to the first configured app if not provided).
 */
api.post('/appstore/test-notification', async (req, res) => {
  const app = pickAppOrDefault(req);
  if (!app) return res.status(400).json({ error: 'no_app_configured' });
  if (!isAppApiConfigured(app)) {
    return res.status(400).json({ error: 'appstore_api_not_configured', app_id: app.id });
  }
  try {
    const environment = req.body?.environment || req.query.environment;
    const out = await requestTestNotification({ app, environment });
    res.json({
      ok: true,
      app_id: app.id,
      environment: (environment || app.environment || 'Production'),
      ...out,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'test_notification_failed', message: err.message });
  }
});

api.get('/appstore/test-notification/:token', async (req, res) => {
  const app = pickAppOrDefault(req);
  if (!app) return res.status(400).json({ error: 'no_app_configured' });
  if (!isAppApiConfigured(app)) {
    return res.status(400).json({ error: 'appstore_api_not_configured', app_id: app.id });
  }
  try {
    const environment = req.query.environment;
    const out = await getTestNotificationStatus(req.params.token, { app, environment });
    res.json({
      ok: true,
      app_id: app.id,
      environment: (environment || app.environment || 'Production'),
      ...out,
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: 'test_notification_status_failed', message: err.message });
  }
});

api.get('/reconcile/status', (req, res) => {
  res.json(getReconcileState());
});

api.post('/reconcile/run', async (req, res) => {
  const app = pickApp(req); // null → all apps
  try {
    const result = await runReconcile({
      limit: Number(req.body?.limit || 200),
      repair: req.body?.repair !== false,
      environment: req.body?.environment,
      app: app || undefined,
    });
    res.json({ ok: true, app_id: app?.id || null, ...result });
  } catch (err) {
    const status = err.message === 'reconcile_already_running' ? 409 : (err.status || 500);
    res.status(status).json({ error: 'reconcile_failed', message: err.message });
  }
});

api.get('/events', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const type = req.query.type;
  const product = req.query.product;
  const app = pickApp(req);

  const where = [];
  const params = {};
  if (app) { where.push('app_id = @app_id'); params.app_id = app.id; }
  if (type && type !== 'all') { where.push('type = @type'); params.type = type; }
  if (product) { where.push('product_id = @product'); params.product = product; }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM events ${whereSql}`).get(params).c;
  const rows = db.prepare(`
    SELECT id, event_id, app_id, type, app_user_id, product_id, period_type, price, price_usd, currency,
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
  const app = pickApp(req);
  const where = app ? `WHERE app_id = ?` : '';
  const params = app ? [app.id, limit] : [limit];
  const rows = db.prepare(`
    SELECT * FROM notifications ${where}
    ORDER BY created_at_ms DESC LIMIT ?
  `).all(...params);
  res.json(rows);
});

/** Renewals özel endpoint: sadece RENEWAL event'leri. */
api.get('/renewals', (req, res) => {
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
  const offset = Math.max(0, parseInt(req.query.offset) || 0);
  const app = pickApp(req);
  const filter = app ? `AND app_id = ?` : '';
  const baseParams = app ? [app.id] : [];
  const rows = db.prepare(`
    SELECT id, app_id, app_user_id, product_id, period_type, price, price_usd, currency, country_code,
           store, event_timestamp_ms, expiration_at_ms
    FROM events WHERE type = 'RENEWAL' ${filter}
    ORDER BY event_timestamp_ms DESC
    LIMIT ? OFFSET ?
  `).all(...baseParams, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'RENEWAL' ${filter}`).get(...baseParams).c;
  res.json({ total, items: rows });
});

// ---- Notifications (push channel: Telegram) ----
api.get('/notify/status', (req, res) => {
  res.json({ telegram: notifyTelegramStatus() });
});

api.post('/notify/test', async (req, res) => {
  try {
    const result = await notifySendPing();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'notify_test_failed', message: err.message });
  }
});

api.post('/notify/digest', async (req, res) => {
  try {
    await notifySendDigest();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'notify_digest_failed', message: err.message });
  }
});

api.get('/summary', (req, res) => {
  const appId = pickApp(req)?.id || null;
  res.json({
    app_id: appId,
    kpis: analytics.kpis(appId),
    daily: analytics.daily(30, appId),
    mrr_history: analytics.mrrHistory(30, appId),
    products: analytics.productBreakdown(appId).slice(0, 10),
    countries: analytics.countryBreakdown(appId).slice(0, 10),
    churn_reasons: analytics.churnReasons(90, appId).slice(0, 10),
    top_subscribers: analytics.topSubscribers(10, appId),
    upcoming_renewals: analytics.upcomingRenewals(168, appId).slice(0, 10),
  });
});
