#!/usr/bin/env node
import 'dotenv/config';
import { backfillUser, backfillAll } from '../services/backfill.js';
import { reloadApps, getApps, getAppById, isAppApiConfigured } from '../services/apps.js';

/**
 * CLI:
 *   npm run backfill                                  # all users in DB across every configured app
 *   npm run backfill -- --app <id>                    # restrict to a single app
 *   npm run backfill -- --user <txId> --app <id>      # single user (app required if you have many)
 *   npm run backfill -- --concurrency 4               # parallelism (default 2)
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user' || a === '-u') out.user = argv[++i];
    else if (a === '--app' || a === '-a') out.app = argv[++i];
    else if (a === '--concurrency' || a === '-c') out.concurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage:
  npm run backfill                              # backfill every user across every configured app
  npm run backfill -- --app <id>                # backfill one app
  npm run backfill -- --user <txId> --app <id>  # backfill one user in a specific app
  npm run backfill -- --concurrency 4           # adjust parallelism (default 2)

Configure apps via APPS_CONFIG (JSON array) or legacy single-app envs:
  APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_BUNDLE_ID
Optional env: APPSTORE_ENVIRONMENT (Production|Sandbox; default Production)
`);
    return;
  }

  reloadApps();
  const apps = getApps();
  if (!apps.length) {
    console.error('No apps configured. Set APPS_CONFIG (JSON array) or legacy APPSTORE_* env vars.');
    process.exit(1);
  }

  let targetApp = null;
  if (args.app) {
    targetApp = getAppById(args.app);
    if (!targetApp) {
      console.error(`Unknown app id "${args.app}". Available: ${apps.map(a => a.id).join(', ')}`);
      process.exit(1);
    }
    if (!isAppApiConfigured(targetApp)) {
      console.error(`App "${targetApp.id}" is missing API credentials (issuer_id, key_id, private_key).`);
      process.exit(1);
    }
  }

  if (args.user) {
    if (!targetApp) {
      if (apps.length > 1) {
        console.error(`--user requires --app when multiple apps are configured. Available: ${apps.map(a => a.id).join(', ')}`);
        process.exit(1);
      }
      targetApp = apps[0];
    }
    console.log(`[backfill] app=${targetApp.id} user=${args.user}`);
    const r = await backfillUser(args.user, { app: targetApp });
    console.log(`[backfill] done: fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} errors=${r.errors}`);
    return;
  }

  const scope = targetApp ? `app=${targetApp.id}` : `every configured app (${apps.length})`;
  console.log(`[backfill] starting full backfill — ${scope}...`);
  const r = await backfillAll({
    concurrency: args.concurrency || 2,
    app: targetApp || undefined,
    onProgress: ({ app_id, processed, total, currentUser }) => {
      if (processed % 10 === 0 || processed === total) {
        console.log(`[backfill] app=${app_id} progress ${processed}/${total} (last: ${currentUser})`);
      }
    },
  });
  console.log(`[backfill] done: users=${r.users} fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} errors=${r.errors}`);
  if (r.apps) {
    for (const [id, sub] of Object.entries(r.apps)) {
      console.log(`  • ${id}: users=${sub.users} fetched=${sub.fetched} inserted=${sub.inserted} skipped=${sub.skipped} errors=${sub.errors}`);
    }
  }
}

main().catch(err => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
