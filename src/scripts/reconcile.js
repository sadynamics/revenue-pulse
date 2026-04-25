#!/usr/bin/env node
import 'dotenv/config';
import { runReconcile } from '../services/reconcile.js';
import { reloadApps, getApps, getAppById, isAppApiConfigured } from '../services/apps.js';

/**
 * CLI:
 *   npm run reconcile                       # every configured app
 *   npm run reconcile -- --app <id>         # one app
 *   npm run reconcile -- --limit=500        # batch size per app
 *   npm run reconcile -- --dry-run          # report drift without repairing
 *   npm run reconcile -- --environment=Sandbox
 */
async function main() {
  reloadApps();
  const apps = getApps();
  if (!apps.length) {
    console.error('No apps configured. Set APPS_CONFIG (JSON array) or legacy APPSTORE_* env vars.');
    process.exit(1);
  }

  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 200;
  const repair = !process.argv.includes('--dry-run');
  const envArg = process.argv.find(a => a.startsWith('--environment='));
  const environment = envArg ? envArg.split('=')[1] : undefined;

  const appArgIdx = process.argv.findIndex(a => a === '--app' || a === '-a');
  const appArg = appArgIdx > -1 ? process.argv[appArgIdx + 1] : null;

  let targetApp = null;
  if (appArg) {
    targetApp = getAppById(appArg);
    if (!targetApp) {
      console.error(`Unknown app id "${appArg}". Available: ${apps.map(a => a.id).join(', ')}`);
      process.exit(1);
    }
    if (!isAppApiConfigured(targetApp)) {
      console.error(`App "${targetApp.id}" is missing API credentials.`);
      process.exit(1);
    }
  }

  const out = await runReconcile({
    limit,
    repair,
    environment,
    app: targetApp || undefined,
  });
  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('[reconcile] fatal:', err.message);
  process.exit(1);
});
