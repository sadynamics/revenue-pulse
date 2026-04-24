import { db } from '../db.js';
import { emit } from './bus.js';
import { toUsd } from './fx.js';

/**
 * Generic internal event shape (source-agnostic):
 * {
 *   event_id, type, app_user_id, original_app_user_id, aliases[],
 *   product_id, entitlement_ids[], period_type,
 *   purchased_at_ms, expiration_at_ms, event_timestamp_ms,
 *   environment, store, currency, price, price_usd,
 *   country_code, is_family_share, is_trial_conversion,
 *   cancel_reason, expiration_reason,
 *   transaction_id, original_transaction_id, web_order_line_item_id, offer_code,
 *   raw_json (string), received_at_ms,
 *   subtype (optional)
 * }
 *
 * Source-specific adapters (e.g. appstore.js) build this object and call `processEvent`.
 */

const DEFAULT_CURRENCY = process.env.DEFAULT_CURRENCY || 'USD';

export function buildEvent(src = {}) {
  const currency = (src.currency || DEFAULT_CURRENCY).toUpperCase();
  const price = src.price ?? 0;
  const priceUsd = src.price_usd != null ? src.price_usd : toUsd(price, currency);

  return {
    event_id: src.event_id || null,
    type: (src.type || 'UNKNOWN').toUpperCase(),
    subtype: src.subtype || null,
    app_user_id: src.app_user_id || src.original_app_user_id || null,
    original_app_user_id: src.original_app_user_id || src.app_user_id || null,
    aliases: JSON.stringify(src.aliases || []),
    product_id: src.product_id || null,
    entitlement_ids: JSON.stringify(src.entitlement_ids || []),
    period_type: src.period_type || null,
    purchased_at_ms: src.purchased_at_ms || null,
    expiration_at_ms: src.expiration_at_ms || null,
    event_timestamp_ms: src.event_timestamp_ms || Date.now(),
    environment: src.environment || 'PRODUCTION',
    store: src.store || 'APP_STORE',
    currency,
    price: Number(price) || 0,
    price_usd: priceUsd,
    country_code: src.country_code || null,
    is_family_share: src.is_family_share ? 1 : 0,
    is_trial_conversion: src.is_trial_conversion ? 1 : 0,
    cancel_reason: src.cancel_reason || null,
    expiration_reason: src.expiration_reason || null,
    transaction_id: src.transaction_id || null,
    original_transaction_id: src.original_transaction_id || null,
    web_order_line_item_id: src.web_order_line_item_id || null,
    offer_code: src.offer_code || null,
    raw_json: typeof src.raw_json === 'string' ? src.raw_json : JSON.stringify(src.raw_json || src),
    received_at_ms: Date.now(),
  };
}

const insertEventStmt = db.prepare(`
  INSERT OR IGNORE INTO events (
    event_id, type, app_user_id, original_app_user_id, aliases, product_id, entitlement_ids,
    period_type, purchased_at_ms, expiration_at_ms, event_timestamp_ms, environment, store,
    currency, price, price_usd, country_code, is_family_share, is_trial_conversion,
    cancel_reason, expiration_reason, transaction_id, original_transaction_id,
    web_order_line_item_id, offer_code, raw_json, received_at_ms
  ) VALUES (
    @event_id, @type, @app_user_id, @original_app_user_id, @aliases, @product_id, @entitlement_ids,
    @period_type, @purchased_at_ms, @expiration_at_ms, @event_timestamp_ms, @environment, @store,
    @currency, @price, @price_usd, @country_code, @is_family_share, @is_trial_conversion,
    @cancel_reason, @expiration_reason, @transaction_id, @original_transaction_id,
    @web_order_line_item_id, @offer_code, @raw_json, @received_at_ms
  )
`);

const getSubscriberStmt = db.prepare('SELECT * FROM subscribers WHERE app_user_id = ?');

const upsertSubscriberStmt = db.prepare(`
  INSERT INTO subscribers (
    app_user_id, original_app_user_id, first_seen_ms, last_event_ms, status,
    current_product_id, current_entitlements, period_type, current_price_usd,
    expiration_ms, country_code, store, environment, will_renew,
    renewals_count, ltv_usd, refunded_usd, trial_converted, ever_trial,
    cancelled_at_ms, cancel_reason
  ) VALUES (
    @app_user_id, @original_app_user_id, @first_seen_ms, @last_event_ms, @status,
    @current_product_id, @current_entitlements, @period_type, @current_price_usd,
    @expiration_ms, @country_code, @store, @environment, @will_renew,
    @renewals_count, @ltv_usd, @refunded_usd, @trial_converted, @ever_trial,
    @cancelled_at_ms, @cancel_reason
  )
  ON CONFLICT(app_user_id) DO UPDATE SET
    original_app_user_id = excluded.original_app_user_id,
    last_event_ms        = excluded.last_event_ms,
    status               = excluded.status,
    current_product_id   = excluded.current_product_id,
    current_entitlements = excluded.current_entitlements,
    period_type          = excluded.period_type,
    current_price_usd    = excluded.current_price_usd,
    expiration_ms        = excluded.expiration_ms,
    country_code         = COALESCE(excluded.country_code, subscribers.country_code),
    store                = COALESCE(excluded.store, subscribers.store),
    environment          = COALESCE(excluded.environment, subscribers.environment),
    will_renew           = excluded.will_renew,
    renewals_count       = excluded.renewals_count,
    ltv_usd              = excluded.ltv_usd,
    refunded_usd         = excluded.refunded_usd,
    trial_converted      = excluded.trial_converted,
    ever_trial           = excluded.ever_trial,
    cancelled_at_ms      = excluded.cancelled_at_ms,
    cancel_reason        = excluded.cancel_reason
`);

const insertNotifStmt = db.prepare(`
  INSERT INTO notifications (event_id, type, title, body, severity, amount_usd, app_user_id, product_id, created_at_ms)
  VALUES (@event_id, @type, @title, @body, @severity, @amount_usd, @app_user_id, @product_id, @created_at_ms)
`);

function applyEventToSubscriber(existing, ev) {
  const now = ev.event_timestamp_ms;
  const base = existing || {
    app_user_id: ev.app_user_id,
    original_app_user_id: ev.original_app_user_id,
    first_seen_ms: now,
    status: 'active',
    current_product_id: null,
    current_entitlements: '[]',
    period_type: null,
    current_price_usd: 0,
    expiration_ms: null,
    country_code: null,
    store: null,
    environment: null,
    will_renew: 1,
    renewals_count: 0,
    ltv_usd: 0,
    refunded_usd: 0,
    trial_converted: 0,
    ever_trial: 0,
    cancelled_at_ms: null,
    cancel_reason: null,
  };

  const sub = { ...base };
  sub.last_event_ms = now;
  sub.country_code = ev.country_code || sub.country_code;
  sub.store = ev.store || sub.store;
  sub.environment = ev.environment || sub.environment;

  switch (ev.type) {
    case 'INITIAL_PURCHASE':
    case 'NON_RENEWING_PURCHASE':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
    case 'RENEWAL':
    case 'SUBSCRIPTION_EXTENDED':
    case 'TEMPORARY_ENTITLEMENT_GRANT':
      sub.status = 'active';
      sub.current_product_id = ev.product_id || sub.current_product_id;
      sub.current_entitlements = ev.entitlement_ids || sub.current_entitlements;
      sub.period_type = ev.period_type || sub.period_type;
      sub.current_price_usd = ev.price_usd || sub.current_price_usd;
      sub.expiration_ms = ev.expiration_at_ms || sub.expiration_ms;
      sub.will_renew = 1;
      sub.cancelled_at_ms = null;
      sub.cancel_reason = null;
      if (ev.period_type === 'TRIAL') sub.ever_trial = 1;
      if (ev.type === 'RENEWAL') {
        sub.renewals_count = (sub.renewals_count || 0) + 1;
        sub.ltv_usd = Number(((sub.ltv_usd || 0) + (ev.price_usd || 0)).toFixed(4));
      }
      if (ev.type === 'INITIAL_PURCHASE' || ev.type === 'NON_RENEWING_PURCHASE') {
        sub.ltv_usd = Number(((sub.ltv_usd || 0) + (ev.price_usd || 0)).toFixed(4));
      }
      if (ev.is_trial_conversion || (ev.type === 'RENEWAL' && base.period_type === 'TRIAL')) {
        sub.trial_converted = 1;
      }
      break;

    case 'CANCELLATION':
      sub.will_renew = 0;
      sub.cancelled_at_ms = now;
      sub.cancel_reason = ev.cancel_reason || sub.cancel_reason;
      // App Store'da "auto-renew disabled" ile abonelik hemen bitmez.
      break;

    case 'SUBSCRIPTION_PAUSED':
      sub.status = 'paused';
      sub.will_renew = 0;
      break;

    case 'EXPIRATION':
      sub.status = 'expired';
      sub.will_renew = 0;
      sub.expiration_ms = ev.expiration_at_ms || sub.expiration_ms || now;
      break;

    case 'BILLING_ISSUE':
      sub.status = 'billing_issue';
      sub.will_renew = 0;
      break;

    case 'REFUND':
      sub.refunded_usd = Number(((sub.refunded_usd || 0) + Math.abs(ev.price_usd || 0)).toFixed(4));
      sub.ltv_usd = Number(((sub.ltv_usd || 0) - Math.abs(ev.price_usd || 0)).toFixed(4));
      break;

    case 'TRANSFER':
    case 'PRICE_INCREASE_CONSENT':
    case 'TEST':
    default:
      break;
  }

  return sub;
}

function buildNotification(ev, eventRowId) {
  const user = (ev.app_user_id || '').slice(0, 10);
  const priceFmt = ev.price_usd ? `$${ev.price_usd.toFixed(2)}` : '';
  const productFmt = ev.product_id ? ` · ${ev.product_id}` : '';

  const map = {
    INITIAL_PURCHASE:      { title: `🎉 New subscriber`,    severity: 'success',  body: `${priceFmt}${productFmt} · ${user}` },
    RENEWAL:               { title: `🔄 Renewal`,           severity: 'success',  body: `${priceFmt}${productFmt} · ${user}` },
    NON_RENEWING_PURCHASE: { title: `🛒 One-time purchase`, severity: 'success',  body: `${priceFmt}${productFmt} · ${user}` },
    PRODUCT_CHANGE:        { title: `🔀 Plan changed`,      severity: 'info',     body: `${productFmt} · ${user}` },
    UNCANCELLATION:        { title: `💚 Re-subscribed`,     severity: 'success',  body: `${user}` },
    CANCELLATION:          { title: `⚠️ Auto-renew off`,    severity: 'warning',  body: `${ev.cancel_reason || ''} · ${user}` },
    EXPIRATION:            { title: `⛔️ Expired`,           severity: 'warning',  body: `${ev.expiration_reason || ''} · ${user}` },
    BILLING_ISSUE:         { title: `💳 Billing retry`,     severity: 'danger',   body: `${user}` },
    SUBSCRIPTION_PAUSED:   { title: `⏸️ Paused`,            severity: 'warning',  body: `${user}` },
    REFUND:                { title: `↩️ Refund`,            severity: 'danger',   body: `${priceFmt} · ${user}` },
    SUBSCRIPTION_EXTENDED: { title: `⏩ Extended`,          severity: 'info',     body: `${user}` },
    PRICE_INCREASE_CONSENT:{ title: `💲 Price increase`,    severity: 'info',     body: `${user}` },
    TRANSFER:              { title: `🔁 Family share`,      severity: 'info',     body: `${user}` },
    TEST:                  { title: `🧪 Test notification`, severity: 'info',     body: `${user}` },
  };

  const meta = map[ev.type] || { title: ev.type, severity: 'info', body: user };
  return {
    event_id: eventRowId,
    type: ev.type,
    title: meta.title,
    body: meta.body,
    severity: meta.severity,
    amount_usd: ev.price_usd || 0,
    app_user_id: ev.app_user_id,
    product_id: ev.product_id,
    created_at_ms: ev.event_timestamp_ms,
  };
}

/** Ingest + subscriber state + notification row (transaction). */
export const ingestEvent = db.transaction((normalizedEv) => {
  const ev = buildEvent(normalizedEv);
  const info = insertEventStmt.run(ev);
  if (info.changes === 0) return { duplicate: true, event: ev };

  if (ev.app_user_id) {
    const existing = getSubscriberStmt.get(ev.app_user_id);
    const updated = applyEventToSubscriber(existing, ev);
    upsertSubscriberStmt.run(updated);
  }

  const notif = buildNotification(ev, info.lastInsertRowid);
  const notifInfo = insertNotifStmt.run(notif);

  return {
    duplicate: false,
    event: ev,
    eventRowId: info.lastInsertRowid,
    notification: { id: notifInfo.lastInsertRowid, ...notif },
  };
});

/** Ingest + realtime broadcast. */
export function processEvent(normalizedEv) {
  const result = ingestEvent(normalizedEv);
  if (!result.duplicate) {
    emit('event', { event: result.event, notification: result.notification });
  }
  return result;
}
