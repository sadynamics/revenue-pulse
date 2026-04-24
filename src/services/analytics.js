import { db } from '../db.js';

const DAY_MS = 24 * 60 * 60 * 1000;

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
      return 0; // sürekli abonelik değil
    case 'TRIAL':
    case 'INTRO':
      return 0; // trial MRR'a sayılmaz
    default:
      return price;
  }
}

/** Güncel KPI'lar. */
export function kpis() {
  const now = Date.now();

  const activeSubs = db.prepare(`
    SELECT * FROM subscribers
    WHERE status IN ('active','paused')
      AND (expiration_ms IS NULL OR expiration_ms > ?)
  `).all(now);

  const payingActive = activeSubs.filter(s => s.period_type !== 'TRIAL' && (s.current_price_usd || 0) > 0);

  const mrr = payingActive.reduce((sum, s) => sum + monthlyNormalizedUsd(s), 0);
  const arr = mrr * 12;
  const trials = activeSubs.filter(s => s.period_type === 'TRIAL').length;

  const last30 = now - 30 * DAY_MS;
  const prev30 = now - 60 * DAY_MS;

  const newSubs30 = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE type = 'INITIAL_PURCHASE' AND event_timestamp_ms >= ?
  `).get(last30).c;

  const newSubsPrev = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE type = 'INITIAL_PURCHASE' AND event_timestamp_ms >= ? AND event_timestamp_ms < ?
  `).get(prev30, last30).c;

  const churned30 = db.prepare(`
    SELECT COUNT(*) AS c FROM events
    WHERE type IN ('EXPIRATION','BILLING_ISSUE') AND event_timestamp_ms >= ?
  `).get(last30).c;

  const revenue30 = db.prepare(`
    SELECT COALESCE(SUM(price_usd),0) AS s FROM events
    WHERE type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') AND event_timestamp_ms >= ?
  `).get(last30).s;

  const refunds30 = db.prepare(`
    SELECT COALESCE(SUM(ABS(price_usd)),0) AS s FROM events
    WHERE type = 'REFUND' AND event_timestamp_ms >= ?
  `).get(last30).s;

  const activeStart30 = db.prepare(`
    SELECT COUNT(*) AS c FROM subscribers
    WHERE first_seen_ms < ? AND (expiration_ms IS NULL OR expiration_ms > ?)
  `).get(last30, last30).c;

  const churnRate = activeStart30 > 0 ? (churned30 / activeStart30) * 100 : 0;

  const trialEver = db.prepare(`SELECT COUNT(*) AS c FROM subscribers WHERE ever_trial = 1`).get().c;
  const trialConverted = db.prepare(`SELECT COUNT(*) AS c FROM subscribers WHERE trial_converted = 1`).get().c;
  const trialConversionRate = trialEver > 0 ? (trialConverted / trialEver) * 100 : 0;

  const avgLtv = db.prepare(`SELECT COALESCE(AVG(ltv_usd),0) AS a FROM subscribers`).get().a;

  const totalRevenue = db.prepare(`
    SELECT COALESCE(SUM(price_usd),0) AS s FROM events
    WHERE type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE')
  `).get().s;
  const totalRefunds = db.prepare(`
    SELECT COALESCE(SUM(ABS(price_usd)),0) AS s FROM events WHERE type = 'REFUND'
  `).get().s;

  return {
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

/** Son N gün için günlük seri: revenue, new subs, churn, active count. */
export function daily(days = 30) {
  const now = new Date();
  const result = [];
  const start = new Date(now.getTime() - (days - 1) * DAY_MS);
  start.setUTCHours(0, 0, 0, 0);

  const revenueRows = db.prepare(`
    SELECT
      CAST((event_timestamp_ms / 86400000) AS INTEGER) AS day,
      SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') THEN price_usd ELSE 0 END) AS revenue,
      SUM(CASE WHEN type = 'REFUND' THEN ABS(price_usd) ELSE 0 END) AS refunds,
      SUM(CASE WHEN type = 'INITIAL_PURCHASE' THEN 1 ELSE 0 END) AS new_subs,
      SUM(CASE WHEN type = 'RENEWAL' THEN 1 ELSE 0 END) AS renewals,
      SUM(CASE WHEN type IN ('EXPIRATION','BILLING_ISSUE') THEN 1 ELSE 0 END) AS churned,
      SUM(CASE WHEN type = 'CANCELLATION' THEN 1 ELSE 0 END) AS cancellations
    FROM events
    WHERE event_timestamp_ms >= ?
    GROUP BY day
  `).all(start.getTime());

  const map = new Map(revenueRows.map(r => [r.day, r]));

  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * DAY_MS);
    const dayKey = Math.floor(d.getTime() / DAY_MS);
    const row = map.get(dayKey) || {};
    result.push({
      date: d.toISOString().slice(0, 10),
      revenue: Number((row.revenue || 0).toFixed(2)),
      refunds: Number((row.refunds || 0).toFixed(2)),
      new_subs: row.new_subs || 0,
      renewals: row.renewals || 0,
      churned: row.churned || 0,
      cancellations: row.cancellations || 0,
    });
  }

  return result;
}

/** MRR'ın zaman içindeki evrimi — subscriber state'inin o an rebuild edilmesiyle. */
export function mrrHistory(days = 30) {
  const now = Date.now();
  const series = [];

  // Önce subscriber state'ini her gün için yeniden oluşturmak yerine,
  // her gün için "o gün sonu itibariyle aktif aboneliklerin MRR'ı" hesabı yapıyoruz.
  // Basit yaklaşım: her güne expiration_ms > day_end AND first_seen_ms <= day_end olan subscriber'ları al.
  const getActive = db.prepare(`
    SELECT period_type, current_price_usd FROM subscribers
    WHERE first_seen_ms <= ? AND (expiration_ms IS NULL OR expiration_ms > ?)
      AND status != 'expired'
  `);

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * DAY_MS);
    d.setUTCHours(23, 59, 59, 999);
    const endMs = d.getTime();
    const rows = getActive.all(endMs, endMs);
    const mrr = rows.reduce((sum, r) => sum + monthlyNormalizedUsd(r), 0);
    series.push({ date: d.toISOString().slice(0, 10), mrr: Number(mrr.toFixed(2)), active: rows.length });
  }
  return series;
}

export function productBreakdown() {
  return db.prepare(`
    SELECT
      current_product_id AS product_id,
      COUNT(*) AS subscribers,
      COALESCE(SUM(current_price_usd),0) AS gross_usd,
      COALESCE(AVG(current_price_usd),0) AS avg_price_usd
    FROM subscribers
    WHERE status IN ('active','paused') AND current_product_id IS NOT NULL
    GROUP BY current_product_id
    ORDER BY subscribers DESC
  `).all().map(r => ({
    ...r,
    gross_usd: Number(r.gross_usd.toFixed(2)),
    avg_price_usd: Number(r.avg_price_usd.toFixed(2)),
  }));
}

export function countryBreakdown() {
  return db.prepare(`
    SELECT
      COALESCE(country_code,'??') AS country,
      COUNT(*) AS subscribers,
      COALESCE(SUM(ltv_usd),0) AS revenue_usd
    FROM subscribers
    WHERE status IN ('active','paused')
    GROUP BY country
    ORDER BY subscribers DESC
    LIMIT 25
  `).all().map(r => ({ ...r, revenue_usd: Number(r.revenue_usd.toFixed(2)) }));
}

export function churnReasons(days = 90) {
  const since = Date.now() - days * DAY_MS;
  return db.prepare(`
    SELECT
      COALESCE(cancel_reason, expiration_reason, 'UNKNOWN') AS reason,
      COUNT(*) AS count
    FROM events
    WHERE type IN ('CANCELLATION','EXPIRATION','BILLING_ISSUE')
      AND event_timestamp_ms >= ?
    GROUP BY reason
    ORDER BY count DESC
  `).all(since);
}

export function topSubscribers(limit = 10) {
  return db.prepare(`
    SELECT app_user_id, ltv_usd, renewals_count, current_product_id, status, country_code, first_seen_ms
    FROM subscribers
    ORDER BY ltv_usd DESC
    LIMIT ?
  `).all(limit);
}

export function storeBreakdown() {
  return db.prepare(`
    SELECT COALESCE(store,'UNKNOWN') AS store, COUNT(*) AS subscribers,
           COALESCE(SUM(current_price_usd),0) AS gross_usd
    FROM subscribers
    WHERE status IN ('active','paused')
    GROUP BY store
    ORDER BY subscribers DESC
  `).all().map(r => ({ ...r, gross_usd: Number(r.gross_usd.toFixed(2)) }));
}

/** Yaklaşan yenilemeler (7 gün). */
export function upcomingRenewals(hours = 168) {
  const now = Date.now();
  const until = now + hours * 60 * 60 * 1000;
  return db.prepare(`
    SELECT app_user_id, current_product_id, expiration_ms, current_price_usd, will_renew, period_type
    FROM subscribers
    WHERE will_renew = 1 AND expiration_ms BETWEEN ? AND ?
    ORDER BY expiration_ms ASC
    LIMIT 50
  `).all(now, until);
}
