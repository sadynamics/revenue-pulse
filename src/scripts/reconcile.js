#!/usr/bin/env node
import 'dotenv/config';
import { runReconcile } from '../services/reconcile.js';
import { isConfigured } from '../services/appstore-api.js';

async function main() {
  if (!isConfigured()) {
    console.error('App Store API not configured. Set APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_BUNDLE_ID.');
    process.exit(1);
  }

  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 200;
  const repair = !process.argv.includes('--dry-run');
  const envArg = process.argv.find(a => a.startsWith('--environment='));
  const environment = envArg ? envArg.split('=')[1] : undefined;

  const out = await runReconcile({ limit, repair, environment });
  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('[reconcile] fatal:', err.message);
  process.exit(1);
});
