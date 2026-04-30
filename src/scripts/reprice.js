#!/usr/bin/env node
/**
 * Recompute `events.price_usd` from `events.price` + `events.currency` using
 * the current FX table, and rebuild subscriber rollups (ltv_usd, refunded_usd,
 * current_price_usd) from the events stream.
 *
 * Use this after expanding fx.js with new currencies (or correcting an
 * existing rate) to fix historical analytics. The script is idempotent — it
 * only writes when the recomputed value differs from what's already stored.
 *
 * Usage:
 *   npm run reprice              # all apps, all events
 *   npm run reprice -- --app id  # one app
 *   npm run reprice -- --dry-run # preview without writing
 */
import 'dotenv/config';
import { db } from '../db.js';
import { reloadApps, getApps } from '../services/apps.js';
import { toUsd, isCurrencySupported } from '../services/fx.js';

reloadApps();

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const appIdx = argv.indexOf('--app');
const appFilter = appIdx >= 0 ? argv[appIdx + 1] : null;

const apps = getApps();
if (!apps.length) {
  console.error('✖ No apps configured. Set APPS_CONFIG and retry.');
  process.exit(1);
}

const targetApps = appFilter ? apps.filter((a) => a.id === appFilter) : apps;
if (!targetApps.length) {
  console.error(`✖ App "${appFilter}" not found. Valid: ${apps.map((a) => a.id).join(', ')}`);
  process.exit(1);
}

console.log(`→ reprice (dry_run=${dryRun})  apps=${targetApps.map((a) => a.id).join(',')}`);

const selectEvents = db.prepare(`
  SELECT id, app_id, type, price, price_usd, currency
  FROM events
  WHERE app_id = ?
`);
const updateEvent = db.prepare(`UPDATE events SET price_usd = ? WHERE id = ?`);

const summary = { events_total: 0, events_updated: 0, currencies_unknown: new Set() };

const tx = db.transaction(() => {
  for (const app of targetApps) {
    const rows = selectEvents.all(app.id);
    for (const r of rows) {
      summary.events_total++;
      const newUsd = toUsd(r.price ?? 0, r.currency);
      if (newUsd == null) {
        summary.currencies_unknown.add(r.currency || '(empty)');
        continue;
      }
      const cur = r.price_usd == null ? null : Number(r.price_usd);
      // Use a small epsilon since we round to 4 decimals.
      if (cur == null || Math.abs(cur - newUsd) > 1e-4) {
        if (!dryRun) updateEvent.run(newUsd, r.id);
        summary.events_updated++;
      }
    }
  }
});
tx();

console.log(`  events: scanned=${summary.events_total}  updated=${summary.events_updated}`);

// ---- Rebuild subscriber rollups from the corrected events ----
console.log('→ rebuilding subscribers.ltv_usd / refunded_usd / current_price_usd');

const subAggregates = db.prepare(`
  SELECT
    app_id,
    app_user_id,
    SUM(CASE WHEN type IN ('INITIAL_PURCHASE','RENEWAL','NON_RENEWING_PURCHASE') THEN COALESCE(price_usd,0) ELSE 0 END) AS gross_usd,
    SUM(CASE WHEN type = 'REFUND' THEN ABS(COALESCE(price_usd,0)) ELSE 0 END) AS refunds_usd
  FROM events
  WHERE app_id IN (${targetApps.map(() => '?').join(',')})
  GROUP BY app_id, app_user_id
`).all(...targetApps.map((a) => a.id));

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

let subsUpdated = 0;
const subTx = db.transaction(() => {
  for (const r of subAggregates) {
    const ltv = Number((r.gross_usd - r.refunds_usd).toFixed(4));
    const ref = Number(r.refunds_usd.toFixed(4));
    const last = latestEvent.get(r.app_id, r.app_user_id);
    const cur = last?.price_usd != null ? Number(last.price_usd) : null;
    if (!dryRun) {
      const info = updateSub.run(ltv, ref, cur, r.app_id, r.app_user_id);
      if (info.changes > 0) subsUpdated++;
    } else {
      subsUpdated++;
    }
  }
});
subTx();

console.log(`  subscribers: rebuilt=${subsUpdated}`);

if (summary.currencies_unknown.size > 0) {
  console.warn(
    `\n⚠ ${summary.currencies_unknown.size} currencies have no FX rate; these events kept their existing price_usd:`
  );
  for (const c of summary.currencies_unknown) console.warn(`    ${c}`);
  console.warn('  Add them to src/services/fx.js → FX_TO_USD and re-run.');
}

console.log(dryRun ? '\n(dry run — no writes performed)' : '\n✓ done');
process.exit(0);
