import { Router } from 'express';
import { readFileSync, existsSync } from 'node:fs';
import { processEvent } from '../services/events.js';
import { decodeNotification, mapNotification } from '../services/appstore.js';
import { maybeBackfillInBackground } from '../services/backfill.js';

export const webhook = Router();

// Apple Root CA sertifikası — verification için. Opsiyonel; sağlanırsa x5c zinciri buna
// kadar doğrulanır. Yoksa sadece imza (leaf cert) doğrulaması yapılır.
let APPLE_ROOT_CERT_PEM = null;
if (process.env.APPLE_ROOT_CERT_PATH && existsSync(process.env.APPLE_ROOT_CERT_PATH)) {
  APPLE_ROOT_CERT_PEM = readFileSync(process.env.APPLE_ROOT_CERT_PATH, 'utf8');
}

const SKIP_VERIFICATION = /^(1|true|yes)$/i.test(process.env.APPSTORE_SKIP_VERIFICATION || '');
const EXPECTED_BUNDLE_ID = process.env.APPSTORE_BUNDLE_ID || null;
const EXPECTED_ENV = (process.env.APPSTORE_ENVIRONMENT || '').toUpperCase();

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

  // Bundle id ve environment kontrolü (yanlış app'ten gelen notification'ları reddet)
  if (EXPECTED_BUNDLE_ID && decoded.data?.bundleId && decoded.data.bundleId !== EXPECTED_BUNDLE_ID) {
    const err = new Error(`bundle_id_mismatch: got ${decoded.data.bundleId}`);
    err.status = 400;
    throw err;
  }
  if (EXPECTED_ENV && decoded.data?.environment && decoded.data.environment.toUpperCase() !== EXPECTED_ENV) {
    // Uyarı olarak logla ama reddetme (sandbox test'lerinde prod endpoint'e gelebilir)
    console.warn(`[webhook] environment mismatch: expected=${EXPECTED_ENV} got=${decoded.data.environment}`);
  }

  const internal = mapNotification(decoded);
  const results = [];
  let insertedCount = 0;
  for (const ev of internal) {
    const r = processEvent(ev);
    results.push(r);
    if (!r.duplicate) insertedCount++;
  }

  // If this is the first time we've seen this Apple user, fetch their full purchase
  // history (auto-renewable + non-renewing + lifetime + consumables) from the App
  // Store Server API so the dashboard isn't blind to anything that happened before
  // we deployed. Runs in the background; webhook responds 200 either way.
  const otid = internal[0]?.original_transaction_id;
  if (otid && insertedCount > 0) {
    maybeBackfillInBackground(otid, insertedCount);
  }

  return { decoded, results };
}

/**
 * Apple App Store Server Notifications V2 endpoint.
 * Request: POST { "signedPayload": "<JWS>" }
 * Response: 200 OK (Apple retries on non-2xx)
 */
webhook.post('/', (req, res) => {
  try {
    const { signedPayload } = req.body || {};
    const { decoded, results } = handleAppleNotification(signedPayload, {
      verify: !SKIP_VERIFICATION,
    });
    const duplicates = results.filter(r => r.duplicate).length;
    return res.status(200).json({
      ok: true,
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
 * Unsigned test endpoint — doğrudan decoded notification payload kabul eder.
 * Sadece dev/debug için kullanılır. İmza doğrulamaz; ya decoded objesini ya da
 * already-normalized generic event'i kabul eder.
 */
webhook.post('/test', (req, res) => {
  try {
    const body = req.body || {};

    // Mode 1: already-normalized event (dashboard'daki Webhook Debug testleri bunu gönderir)
    if (body.type && body.app_user_id) {
      const result = processEvent(body);
      return res.json({ ok: true, duplicate: result.duplicate });
    }

    // Mode 2: decoded Apple notification objesi (signedPayload olmadan)
    if (body.notificationType) {
      const internal = mapNotification(body);
      const results = internal.map(processEvent);
      return res.json({
        ok: true,
        notificationType: body.notificationType,
        subtype: body.subtype,
        processed: results.length,
        duplicates: results.filter(r => r.duplicate).length,
      });
    }

    // Mode 3: signedPayload (verification bypass ile)
    if (body.signedPayload) {
      const out = handleAppleNotification(body.signedPayload, { verify: false });
      return res.json({
        ok: true,
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
