import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { api } from './routes/api.js';
import { webhook } from './routes/webhook.js';
import { sse } from './routes/sse.js';
import { startReconcileScheduler } from './services/reconcile.js';
import './db.js';
import { reloadApps, getApps } from './services/apps.js';

reloadApps();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Webhook body limit: RevenueCat event'leri genelde küçük ama marjinli bırak.
app.use('/webhook', express.json({ limit: '1mb' }), webhook);

app.use(express.json({ limit: '256kb' }));

// Basit Basic Auth (opsiyonel).
function basicAuth(req, res, next) {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASS;
  if (!user || !pass) return next();

  const header = req.headers.authorization || '';
  const [scheme, b64] = header.split(' ');
  if (scheme === 'Basic' && b64) {
    const [u, p] = Buffer.from(b64, 'base64').toString().split(':');
    if (u === user && p === pass) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Revenue Pulse"');
  return res.status(401).send('Authentication required');
}

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.use('/api', basicAuth, api);
app.use('/sse', basicAuth, sse);

// Statik dashboard
app.use('/', basicAuth, express.static(resolve(__dirname, '../public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  extensions: ['html'],
}));

app.use((err, req, res, next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'server_error', message: err.message });
});

app.listen(PORT, () => {
  console.log(`\n  ⚡ Revenue Pulse ready at http://localhost:${PORT}`);
  console.log(`  ⤷ Webhook:   POST /webhook`);
  console.log(`  ⤷ Dashboard: /`);
  const apps = getApps();
  if (apps.length === 0) {
    console.log('  ⤷ Apps:      (none configured — set APPS_CONFIG or APPSTORE_* env vars)\n');
  } else {
    console.log(`  ⤷ Apps:      ${apps.map(a => `${a.id} (${a.bundle_id}, ${a.environment})`).join(', ')}\n`);
  }
  startReconcileScheduler();
});
