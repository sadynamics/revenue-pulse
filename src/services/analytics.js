import { db } from '../db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Helper to inject an optional app_id filter into a SQL fragment.
 * Returns { sql, params } where the caller can do `WHERE x = ? ${sql}`.
 *
 * If `appId` is null/undefined → no filter is applied (= all apps).
 */
function appFilter(appId, table = '') {
  if (!appId) return { sql: '', params: [] };
  const col = table ? `${table}.app_id` : 'app_id';
  return { sql: ` AND ${col} = ?`, params: [appId] };
}

/** Period_type'e göre aylık normalize edilmiş gelir (USD). */
function monthlyNormalizedUsd(row) {
  const price = row.current_price_usd || 0;
  if (!price) return 0;
  switch (row.period_type) {
    case 'NORMAL':
    case 'MONTHLY':
      return price;
    case 'ANNUAL':
    case 'YEARLY':
      return price / 12;
    case 'WEEKLY':
      return (price * 52) / 12;
    case 'LIFETIME':
      return 0;
    case 'TRIAL':
    case 'INTRO':
      return 0;
    default:
      return price;
  }
}

/** Güncel KPI'lar (opsiyonel app_id filtresiyle). */
export function kpis(appId = null) {
  const now = Date.now();
  const fSubs = appFilter(appId);
  const fEv = appFilter(appId);

  const activeSubs = db.prepare(`
    SELECT * FROM subscribers
    WHERE status IN ('active','paused')
      AND (expiration_ms IS NULL OR expiration_ms > ?)
      ${fSubs.sql}
  `).all(now, ...fSubs.params);

  const payingActive = activeSubs.filter(s => s.period_type !== 'TRIAL' && (s.current_price_usd || 0) > 0);

  const mrr = payingActive.reduce((sum, s) => sum + monthlyNormalizedUsd(s), 0);
  const arr = mrr * 12;
  const trials = activeSubs.filter(s => s.period_type === 'TRIAL').length;

  const last30 = now - 30 * DAY_MS;
  const prev30 = now - 60 * DAY_MS;

  const newSubs30 = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE type = 'INITIAL_PURCHASE' AND event_timestamp_ms >= ? ${fEv.sql}
  `).get(last30, ...fEv.params).c;

  const newSubsPrev = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE type = 'INITIAL_PURCHASE' AND event_timestamp_ms >= ? AND event_timestamp_ms < ? ${fEv.sql}
  `).get(prev30, last30, ...fEv.params).c;

  const churned30 = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE type IN ('EXPIRATION','BILLING_ISSUE') AND event_timestamp_ms >= ? ${fEv.sql}
  `).get(last30, ...fEv.params).c;

  const revenue30 = db.prepare(`
    SELECT COALESCE(SUM(price_usd),0) AS s FROM events
    WHERE type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') AND event_timestamp_ms >= ? ${fEv.sql}
  `).get(last30, ...fEv.params).s;

  const refunds30 = db.prepare(`
    SELECT COALESCE(SUM(ABS(price_usd)),0) AS s FROM events
    WHERE type = 'REFUND' AND event_timestamp_ms >= ? ${fEv.sql}
  `).get(last30, ...fEv.params).s;

  const activeStart30 = db.prepare(`
    SELECT COUNT(*) AS c FROM subscribers
    WHERE first_seen_ms < ? AND (expiration_ms IS NULL OR expiration_ms > ?) ${fSubs.sql}
  `).get(last30, last30, ...fSubs.params).c;

  const churnRate = activeStart30 > 0 ? (churned30 / activeStart30) * 100 : 0;

  const trialEver = db.prepare(`SELECT COUNT(*) AS c FROM subscribers WHERE ever_trial = 1 ${fSubs.sql}`).get(...fSubs.params).c;
  const trialConverted = db.prepare(`SELECT COUNT(*) AS c FROM subscribers WHERE trial_converted = 1 ${fSubs.sql}`).get(...fSubs.params).c;
  const trialConversionRate = trialEver > 0 ? (trialConverted / trialEver) * 100 : 0;

  const avgLtv = db.prepare(`SELECT COALESCE(AVG(ltv_usd),0) AS a FROM subscribers WHERE 1=1 ${fSubs.sql}`).get(...fSubs.params).a;

  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(price_usd),0) AS s FROM events
    WHERE type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') ${fEv.sql}
  `).get(...fEv.params).s;
  const totalRefunds = db.prepare(`
    SELECT COALESCE(SUM(ABS(price_usd)),0) AS s FROM events WHERE type = 'REFUND' ${fEv.sql}
  `).get(...fEv.params).s;

  return {
    app_id: appId || null,
    mrr: Number(mrr.toFixed(2)),
    arr: Number(arr.toFixed(2)),
    active_subscribers: activeSubs.length,
    paying_subscribers: payingActive.length,
    trial_subscribers: trials,
    new_subs_30d: newSubs30,
    new_subs_growth_pct: newSubsPrev > 0 ? Number((((newSubs30 - newSubsPrev) / newSubsPrev) * 100).toFixed(1)) : null,
    churned_30d: churned30,
    churn_rate_30d_pct: Number(churnRate.toFixed(2)),
    revenue_30d: Number(revenue30.toFixed(2)),
    refunds_30d: Number(refunds30.toFixed(2)),
    net_revenue_30d: Number((revenue30 - refunds30).toFixed(2)),
    avg_ltv_usd: Number(avgLtv.toFixed(2)),
    trial_conversion_pct: Number(trialConversionRate.toFixed(2)),
    total_revenue: Number(totalRevenue.toFixed(2)),
    total_refunds: Number(totalRefunds.toFixed(2)),
    updated_at: now,
  };
}

/** Son N gün için günlük seri. */
export function daily(days = 30, appId = null) {
  const now = new Date();
  const result = [];
  const start = new Date(now.getTime() - (days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  const f = appFilter(appId);

  const revenueRows = db.prepare(`
    SELECT
      CAST((event_timestamp_ms / 86400000) AS INTEGER) AS day,
      SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') THEN price_usd ELSE 0 END) AS revenue,
      SUM(CASE WHEN type = 'REFUND' THEN ABS(price_usd) ELSE 0 END) AS refunds,
      SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') AND environment = 'PRODUCTION' THEN price_usd ELSE 0 END) AS prod_revenue,
      SUM(CASE WHEN type = 'REFUND' AND environment = 'PRODUCTION' THEN ABS(price_usd) ELSE 0 END) AS prod_refunds,
      SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') AND environment = 'SANDBOX' THEN price_usd ELSE 0 END) AS sandbox_revenue,
      SUM(CASE WHEN type = 'REFUND' AND environment = 'SANDBOX' THEN ABS(price_usd) ELSE 0 END) AS sandbox_refunds,
      SUM(CASE WHEN type = 'INITIAL_PURCHASE' THEN 1 ELSE 0 END) AS new_subs,
      SUM(CASE WHEN type = 'RENEWAL' THEN 1 ELSE 0 END) AS renewals,
      SUM(CASE WHEN type IN ('EXPIRATION','BILLING_ISSUE') THEN 1 ELSE 0 END) AS churned,
      SUM(CASE WHEN type = 'CANCELLATION' THEN 1 ELSE 0 END) AS cancellations
    FROM events
    WHERE event_timestamp_ms >= ? ${f.sql}
    GROUP BY day
  `).all(start.getTime(), ...f.params);

  const map = new Map(revenueRows.map(r => [r.day, r]));

  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    const dayKey = Math.floor(d.getTime() / DAY_MS);
    const row = map.get(dayKey) || {};
    result.push({
      date: d.toISOString().slice(0, 10),
      revenue: Number((row.revenue || 0).toFixed(2)),
      refunds: Number((row.refunds || 0).toFixed(2)),
      net_revenue: Number(((row.revenue || 0) - (row.refunds || 0)).toFixed(2)),
      production_revenue: Number((row.prod_revenue || 0).toFixed(2)),
      production_refunds: Number((row.prod_refunds || 0).toFixed(2)),
      production_net_revenue: Number(((row.prod_revenue || 0) - (row.prod_refunds || 0)).toFixed(2)),
      sandbox_revenue: Number((row.sandbox_revenue || 0).toFixed(2)),
      sandbox_refunds: Number((row.sandbox_refunds || 0).toFixed(2)),
      sandbox_net_revenue: Number(((row.sandbox_revenue || 0) - (row.sandbox_refunds || 0)).toFixed(2)),
      new_subs: row.new_subs || 0,
      renewals: row.renewals || 0,
      churned: row.churned || 0,
      cancellations: row.cancellations || 0,
    });
  }

  return result;
}

/**
 * Daily revenue grouped by app — useful for the multi-app dashboard breakdown
 * view that shows each app's per-day net revenue side by side.
 *
 * Returns:
 *   {
 *     days:  ['2026-04-01', '2026-04-02', ...],
 *     apps:  [{ id, name, bundle_id, environment }, ...],
 *     rows:  [
 *       { date, total_net, by_app: { <app_id>: { revenue, refunds, net }, ... } },
 *       ...
 *     ],
 *     totals_by_app: { <app_id>: { revenue, refunds, net } },
 *     grand_total:   { revenue, refunds, net },
 *   }
 *
 * Days without activity are still emitted so the table can render a complete
 * timeline. Apps with zero activity in the window are NOT pruned — they show
 * up as `$0.00` columns to make multi-app comparison fair.
 */
export function dailyByApp(days = 30) {
  const now = new Date();
  const start = new Date(now.getTime() - (days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);
  const startMs = start.getTime();

  const rows = db.prepare(`
    SELECT
      app_id,
      CAST((event_timestamp_ms / 86400000) AS INTEGER) AS day,
      SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') THEN price_usd ELSE 0 END) AS revenue,
      SUM(CASE WHEN type = 'REFUND' THEN ABS(price_usd) ELSE 0 END) AS refunds
    FROM events
    WHERE event_timestamp_ms >= ?
    GROUP BY app_id, day
  `).all(startMs);

  // Pull app metadata so we can render names, even if some apps had no events.
  const apps = db.prepare(`
    SELECT id, name, bundle_id, environment FROM apps ORDER BY id
  `).all();

  // Index rows by `${app_id}|${day}` for fast lookup.
  const idx = new Map();
  for (const r of rows) {
    idx.set(`${r.app_id || ''}|${r.day}`, r);
  }

  const totalsByApp = {};
  for (const a of apps) totalsByApp[a.id] = { revenue: 0, refunds: 0, net: 0 };

  const result = [];
  let grandRev = 0, grandRef = 0;

  for (let i = 0; i < days; i++) {
    const d = new Date(startMs + i * DAY_MS);
    const dayKey = Math.floor(d.getTime() / DAY_MS);
    const date = d.toISOString().slice(0, 10);
    const byApp = {};
    let totalNet = 0;

    for (const a of apps) {
      const r = idx.get(`${a.id}|${dayKey}`) || { revenue: 0, refunds: 0 };
      const revenue = Number((r.revenue || 0).toFixed(2));
      const refunds = Number((r.refunds || 0).toFixed(2));
      const net = Number((revenue - refunds).toFixed(2));
      byApp[a.id] = { revenue, refunds, net };
      totalsByApp[a.id].revenue = Number((totalsByApp[a.id].revenue + revenue).toFixed(2));
      totalsByApp[a.id].refunds = Number((totalsByApp[a.id].refunds + refunds).toFixed(2));
      totalsByApp[a.id].net     = Number((totalsByApp[a.id].net     + net    ).toFixed(2));
      grandRev += revenue;
      grandRef += refunds;
      totalNet += net;
    }

    result.push({
      date,
      total_net: Number(totalNet.toFixed(2)),
      by_app: byApp,
    });
  }

  return {
    days: result.map(r => r.date),
    apps,
    rows: result,
    totals_by_app: totalsByApp,
    grand_total: {
      revenue: Number(grandRev.toFixed(2)),
      refunds: Number(grandRef.toFixed(2)),
      net: Number((grandRev - grandRef).toFixed(2)),
    },
  };
}

export function mrrHistory(days = 30, appId = null) {
  const now = Date.now();
  const series = [];
  const f = appFilter(appId);

  const getActive = db.prepare(`
    SELECT period_type, current_price_usd FROM subscribers
    WHERE first_seen_ms <= ? AND (expiration_ms IS NULL OR expiration_ms > ?)
      AND status != 'expired' ${f.sql}
  `);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS);
    d.setUTCHours(23, 59, 59, 999);
    const endMs = d.getTime();
    const rows = getActive.all(endMs, endMs, ...f.params);
    const mrr = rows.reduce((sum, r) => sum + monthlyNormalizedUsd(r), 0);
    series.push({ date: d.toISOString().slice(0, 10), mrr: Number(mrr.toFixed(2)), active: rows.length });
  }
  return series;
}

export function productBreakdown(appId = null) {
  const f = appFilter(appId);
  return db.prepare(`
    SELECT
      current_product_id AS product_id,
      COUNT(*) AS subscribers,
      COALESCE(SUM(current_price_usd),0) AS gross_usd,
      COALESCE(AVG(current_price_usd),0) AS avg_price_usd
    FROM subscribers
    WHERE status IN ('active','paused') AND current_product_id IS NOT NULL ${f.sql}
    GROUP BY current_product_id
    ORDER BY subscribers DESC
  `).all(...f.params).map(r => ({
    ...r,
    gross_usd: Number(r.gross_usd.toFixed(2)),
    avg_price_usd: Number(r.avg_price_usd.toFixed(2)),
  }));
}

export function countryBreakdown(appId = null) {
  const f = appFilter(appId);
  return db.prepare(`
    SELECT
      COALESCE(country_code,'??') AS country,
      COUNT(*) AS subscribers,
      COALESCE(SUM(ltv_usd),0) AS revenue_usd
    FROM subscribers
    WHERE status IN ('active','paused') ${f.sql}
    GROUP BY country
    ORDER BY subscribers DESC
    LIMIT 25
  `).all(...f.params).map(r => ({ ...r, revenue_usd: Number(r.revenue_usd.toFixed(2)) }));
}

export function churnReasons(days = 90, appId = null) {
  const since = Date.now() - days * DAY_MS;
  const f = appFilter(appId);
  return db.prepare(`
    SELECT
      COALESCE(cancel_reason, expiration_reason, 'UNKNOWN') AS reason,
      COUNT(*) AS count
    FROM events
    WHERE type IN ('CANCELLATION','EXPIRATION','BILLING_ISSUE')
      AND event_timestamp_ms >= ? ${f.sql}
    GROUP BY reason
    ORDER BY count DESC
  `).all(since, ...f.params);
}

export function topSubscribers(limit = 10, appId = null) {
  const f = appFilter(appId);
  return db.prepare(`
    SELECT app_id, app_user_id, ltv_usd, renewals_count, current_product_id, status, country_code, first_seen_ms
    FROM subscribers
    WHERE 1=1 ${f.sql}
    ORDER BY ltv_usd DESC
    LIMIT ?
  `).all(...f.params, limit);
}

export function storeBreakdown(appId = null) {
  const f = appFilter(appId);
  return db.prepare(`
    SELECT COALESCE(store,'UNKNOWN') AS store, COUNT(*) AS subscribers,
           COALESCE(SUM(current_price_usd),0) AS gross_usd
    FROM subscribers
    WHERE status IN ('active','paused') ${f.sql}
    GROUP BY store
    ORDER BY subscribers DESC
  `).all(...f.params).map(r => ({ ...r, gross_usd: Number(r.gross_usd.toFixed(2)) }));
}

export function upcomingRenewals(hours = 168, appId = null) {
  const now = Date.now();
  const until = now + hours * 60 * 60 * 1000;
  const f = appFilter(appId);
  return db.prepare(`
    SELECT app_id, app_user_id, current_product_id, expiration_ms, current_price_usd, will_renew, period_type
    FROM subscribers
    WHERE will_renew = 1 AND expiration_ms BETWEEN ? AND ? ${f.sql}
    ORDER BY expiration_ms ASC
    LIMIT 50
  `).all(now, until, ...f.params);
}
