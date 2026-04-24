#!/usr/bin/env node
import 'dotenv/config';
import { backfillUser, backfillAll } from '../services/backfill.js';
import { isConfigured } from '../services/appstore-api.js';

/**
 * CLI:
 *   npm run backfill                          # all users in DB
 *   npm run backfill -- --user <txId>         # single user
 *   npm run backfill -- --concurrency 4       # parallelism (default 2)
 */
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--user' || a === '-u') out.user = argv[++i];
    else if (a === '--concurrency' || a === '-c') out.concurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`Usage:
  npm run backfill                       # backfill every user in the DB
  npm run backfill -- --user <txId>      # backfill one user (any transactionId in their family)
  npm run backfill -- --concurrency 4    # adjust parallelism (default 2)

Required env: APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_BUNDLE_ID
Optional env: APPSTORE_ENVIRONMENT (Production|Sandbox; default Production)
`);
    return;
  }

  if (!isConfigured()) {
    console.error('App Store Server API is not configured. Set APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY (or APPSTORE_PRIVATE_KEY_PATH), and APPSTORE_BUNDLE_ID.');
    process.exit(1);
  }

  if (args.user) {
    console.log(`[backfill] user=${args.user}`);
    const r = await backfillUser(args.user);
    console.log(`[backfill] done: fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} errors=${r.errors}`);
    return;
  }

  console.log('[backfill] starting full backfill of every user in DB...');
  const r = await backfillAll({
    concurrency: args.concurrency || 2,
    onProgress: ({ processed, total, currentUser }) => {
      if (processed % 10 === 0 || processed === total) {
        console.log(`[backfill] progress ${processed}/${total} (last: ${currentUser})`);
      }
    },
  });
  console.log(`[backfill] done: users=${r.users} fetched=${r.fetched} inserted=${r.inserted} skipped=${r.skipped} errors=${r.errors}`);
}

main().catch(err => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
