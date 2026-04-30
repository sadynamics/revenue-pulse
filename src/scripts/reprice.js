#!/usr/bin/env node
/**
 * Recompute `events.price_usd` from `events.price` + `events.currency` using
 * the current FX table, and rebuild subscriber rollups.
 *
 * Usage:
 *   npm run reprice              # all apps, all events
 *   npm run reprice -- --app id  # one app
 *   npm run reprice -- --dry-run # preview without writing
 */
import 'dotenv/config';
import '../db.js';
import { reloadApps } from '../services/apps.js';
import { runReprice } from '../services/reprice.js';

reloadApps();

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const appIdx = argv.indexOf('--app');
const appFilter = appIdx >= 0 ? argv[appIdx + 1] : null;

try {
  const r = runReprice({ dryRun, appId: appFilter });
  console.log(`→ reprice (dry_run=${r.dry_run})  apps=${r.apps.join(',')}`);
  console.log(`  events: scanned=${r.events_scanned}  updated=${r.events_updated}`);
  console.log(`  subscribers: rebuilt=${r.subscribers_rebuilt}`);
  if (r.currencies_unknown.length > 0) {
    console.warn(
      `\n⚠ ${r.currencies_unknown.length} currencies have no FX rate; events kept their existing price_usd:`
    );
    for (const c of r.currencies_unknown) console.warn(`    ${c}`);
    console.warn('  Add them to src/services/fx.js → FX_TO_USD and re-run.');
  }
  console.log(dryRun ? '\n(dry run — no writes performed)' : '\n✓ done');
  process.exit(0);
} catch (err) {
  console.error(`✖ ${err.message}`);
  process.exit(1);
}
