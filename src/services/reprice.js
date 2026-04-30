/**
 * Replays `events.price_usd` and subscriber rollups (ltv_usd, refunded_usd,
 * current_price_usd) using the current FX table.
 *
 * Idempotent: re-running with no FX changes is a no-op. Used to repair
 * historical analytics after currencies are added/corrected in fx.js.
 */
import { db } from '../db.js';
import { toUsd } from './fx.js';
import { getApps, getAppById } from './apps.js';

/**
 * @param {{ dryRun?: boolean, appId?: string|null }} opts
 * @returns {{
 *   apps: string[],
 *   events_scanned: number,
 *   events_updated: number,
 *   subscribers_rebuilt: number,
 *   currencies_unknown: string[],
 *   dry_run: boolean,
 * }}
 */
export function runReprice({ dryRun = false, appId = null } = {}) {
  const apps = getApps();
  if (!apps.length) {
    const err = new Error('no_apps_configured');
    err.status = 400;
    throw err;
  }

  let targetApps;
  if (appId) {
    const a = getAppById(appId);
    if (!a) {
      const err = new Error(`app_not_found: ${appId}`);
      err.status = 404;
      throw err;
    }
    targetApps = [a];
  } else {
    targetApps = apps;
  }

  const selectEvents = db.prepare(`
    SELECT id, app_id, type, price, price_usd, currency
    FROM events
    WHERE app_id = ?
  `);
  const updateEvent = db.prepare(`UPDATE events SET price_usd = ? WHERE id = ?`);

  const summary = {
    apps: targetApps.map((a) => a.id),
    events_scanned: 0,
    events_updated: 0,
    subscribers_rebuilt: 0,
    currencies_unknown: new Set(),
    dry_run: dryRun,
  };

  const eventsTx = db.transaction(() => {
    for (const app of targetApps) {
      const rows = selectEvents.all(app.id);
      for (const r of rows) {
        summary.events_scanned++;
        const newUsd = toUsd(r.price ?? 0, r.currency);
        if (newUsd == null) {
          summary.currencies_unknown.add(r.currency || '(empty)');
          continue;
        }
        const cur = r.price_usd == null ? null : Number(r.price_usd);
        if (cur == null || Math.abs(cur - newUsd) > 1e-4) {
          if (!dryRun) updateEvent.run(newUsd, r.id);
          summary.events_updated++;
        }
      }
    }
  });
  eventsTx();

  // ---- Rebuild subscriber rollups from the corrected events ----
  const placeholders = targetApps.map(() => '?').join(',');
  const subAggregates = db
    .prepare(
      `
        SELECT
          app_id,
          app_user_id,
          SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') THEN COALESCE(price_usd,0) ELSE 0 END) AS gross_usd,
          SUM(CASE WHEN type = 'REFUND' THEN ABS(COALESCE(price_usd,0)) ELSE 0 END) AS refunds_usd
        FROM events
        WHERE app_id IN (${placeholders})
        GROUP BY app_id, app_user_id
      `
    )
    .all(...targetApps.map((a) => a.id));

  const latestEvent = db.prepare(`
    SELECT price_usd FROM events
    WHERE app_id = ? AND app_user_id = ?
      AND type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE','PRODUCT_CHANGE')
    ORDER BY event_timestamp_ms DESC
    LIMIT 1
  `);
  const updateSub = db.prepare(`
    UPDATE subscribers
       SET ltv_usd = ?, refunded_usd = ?, current_price_usd = ?
     WHERE app_id = ? AND app_user_id = ?
  `);

  const subTx = db.transaction(() => {
    for (const r of subAggregates) {
      const ltv = Number((r.gross_usd - r.refunds_usd).toFixed(4));
      const ref = Number(r.refunds_usd.toFixed(4));
      const last = latestEvent.get(r.app_id, r.app_user_id);
      const cur = last?.price_usd != null ? Number(last.price_usd) : null;
      if (!dryRun) {
        const info = updateSub.run(ltv, ref, cur, r.app_id, r.app_user_id);
        if (info.changes > 0) summary.subscribers_rebuilt++;
      } else {
        summary.subscribers_rebuilt++;
      }
    }
  });
  subTx();

  return {
    ...summary,
    currencies_unknown: Array.from(summary.currencies_unknown),
  };
}
