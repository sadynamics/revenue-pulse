import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { processEvent } from '../services/events.js';
import { decodeNotification, mapNotification } from '../services/appstore.js';
import { maybeBackfillInBackground } from '../services/backfill.js';
import { resolveAppForBundleId, getApps } from '../services/apps.js';

export const webhook = Router();

// Apple Root CA — optional, used for full x5c chain verification.
let APPLE_ROOT_CERT_PEM = null;
if (process.env.APPLE_ROOT_CERT_PATH && existsSync(process.env.APPLE_ROOT_CERT_PATH)) {
  APPLE_ROOT_CERT_PEM = readFileSync(process.env.APPLE_ROOT_CERT_PATH, 'utf8');
}

const SKIP_VERIFICATION = /^(1|true|yes)$/i.test(process.env.APPSTORE_SKIP_VERIFICATION || '');
const STRICT_BUNDLE_ID = /^(1|true|yes)$/i.test(process.env.STRICT_BUNDLE_ID || '');

function handleAppleNotification(signedPayload, { verify }) {
  if (!signedPayload || typeof signedPayload !== 'string') {
    const err = new Error('signedPayload is required (string JWS)');
    err.status = 400;
    throw err;
  }

  let decoded;
  try {
    decoded = decodeNotification(signedPayload, {
      verify,
      appleRootCertPem: APPLE_ROOT_CERT_PEM,
    });
  } catch (err) {
    err.status = 400;
    err.message = `decode_failed: ${err.message}`;
    throw err;
  }

  // Resolve which app this notification belongs to via bundleId.
  const bundleId = decoded.data?.bundleId || null;
  const app = resolveAppForBundleId(bundleId, { strict: STRICT_BUNDLE_ID });
  if (!app) {
    const apps = getApps();
    const reason = apps.length === 0
      ? 'no_apps_configured'
      : `bundle_id_unrecognized: ${bundleId}`;
    const err = new Error(reason);
    err.status = 400;
    throw err;
  }
  if (bundleId && bundleId !== app.bundle_id && STRICT_BUNDLE_ID) {
    const err = new Error(`bundle_id_mismatch: got ${bundleId}, expected ${app.bundle_id}`);
    err.status = 400;
    throw err;
  }
  if (bundleId && bundleId !== app.bundle_id) {
    console.warn(`[webhook] routed by default app (${app.id}); incoming bundleId=${bundleId}`);
  }

  if (app.environment && decoded.data?.environment) {
    const expected = app.environment.toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
    const got = (decoded.data.environment || '').toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
    if (expected !== got) {
      console.warn(`[webhook] env mismatch for app=${app.id} expected=${expected} got=${got}`);
    }
  }

  const internal = mapNotification(decoded, { appId: app.id });
  const results = [];
  let insertedCount = 0;
  for (const ev of internal) {
    const r = processEvent(ev);
    results.push(r);
    if (!r.duplicate) insertedCount++;
  }

  // Background-backfill new users so we can show pre-deploy history.
  const otid = internal[0]?.original_transaction_id;
  if (otid && insertedCount > 0) {
    maybeBackfillInBackground(otid, insertedCount, app);
  }

  return { decoded, results, app };
}

/**
 * Apple App Store Server Notifications V2 endpoint.
 * Request: POST { "signedPayload": "<JWS>" }
 * Response: 200 OK (Apple retries on non-2xx)
 */
webhook.post('/', (req, res) => {
  try {
    const { signedPayload } = req.body || {};
    const { decoded, results, app } = handleAppleNotification(signedPayload, {
      verify: !SKIP_VERIFICATION,
    });
    const duplicates = results.filter(r => r.duplicate).length;
    return res.status(200).json({
      ok: true,
      app_id: app.id,
      notificationType: decoded.notificationType,
      subtype: decoded.subtype,
      notificationUUID: decoded.notificationUUID,
      processed: results.length,
      duplicates,
    });
  } catch (err) {
    console.error('[webhook] error:', err.message);
    return res.status(err.status || 500).json({ error: 'ingest_failed', message: err.message });
  }
});

/**
 * Unsigned test endpoint — accepts decoded notification payloads or already-
 * normalized events. Dev/debug only; bypasses JWS verification.
 *
 * If the payload contains a bundleId we recognize, the event is routed to that
 * app. Otherwise we route to the default app so the local simulator keeps
 * working without extra config.
 */
webhook.post('/test', (req, res) => {
  try {
    const body = req.body || {};

    // Allow callers to override the app explicitly.
    const overrideAppId = body.app_id || req.query?.app_id || null;

    // Mode 1: already-normalized event.
    if (body.type && body.app_user_id) {
      let appId = overrideAppId || body.app_id;
      if (!appId) {
        const fallback = resolveAppForBundleId(null, { strict: false });
        appId = fallback?.id || null;
      }
      const result = processEvent({ ...body, app_id: appId });
      return res.json({ ok: true, app_id: appId, duplicate: result.duplicate });
    }

    // Mode 2: decoded Apple notification.
    if (body.notificationType) {
      const bundleId = body.data?.bundleId || null;
      const app = overrideAppId
        ? resolveAppForBundleId(null, { strict: false }) // overrideAppId path below
        : resolveAppForBundleId(bundleId, { strict: false });
      const targetApp = overrideAppId
        ? (getApps().find(a => a.id === overrideAppId) || app)
        : app;
      if (!targetApp) {
        return res.status(400).json({ error: 'no_app_resolved', bundle_id: bundleId });
      }
      const internal = mapNotification(body, { appId: targetApp.id });
      const results = internal.map(processEvent);
      return res.json({
        ok: true,
        app_id: targetApp.id,
        notificationType: body.notificationType,
        subtype: body.subtype,
        processed: results.length,
        duplicates: results.filter(r => r.duplicate).length,
      });
    }

    // Mode 3: signedPayload (verification bypass).
    if (body.signedPayload) {
      const out = handleAppleNotification(body.signedPayload, { verify: false });
      return res.json({
        ok: true,
        app_id: out.app.id,
        notificationType: out.decoded.notificationType,
        subtype: out.decoded.subtype,
        processed: out.results.length,
      });
    }

    res.status(400).json({ error: 'unknown_payload_shape' });
  } catch (err) {
    console.error('[webhook/test] error:', err.message);
    res.status(err.status || 500).json({ error: 'ingest_failed', message: err.message });
  }
});
