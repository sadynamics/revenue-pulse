/**
 * Notification dispatcher.
 *
 *  - Subscribes to the in-process event bus and pushes a Telegram message for
 *    every (recent) ingested event.
 *  - Schedules a once-a-day digest summarising the previous day's revenue and
 *    activity (RevenueCat-style "Today $X" header).
 *
 * Configuration is via env vars, see `.env.example`. The service is a no-op
 * unless TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set.
 */

import { on } from '../bus.js';
import { getAppById, getApps } from '../apps.js';
import * as analytics from '../analytics.js';
import * as telegram from './telegram.js';
import { formatEventMessage, formatDailyDigest, formatUsd } from './format.js';

// ---------------- per-event push ----------------

/** Default opt-in event types; everything else is suppressed. */
const DEFAULT_TYPES = [
  'INITIAL_PURCHASE',
  'RENEWAL',
  'NON_RENEWING_PURCHASE',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'CANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'SUBSCRIPTION_PAUSED',
  'REFUND',
  'REVOKE',
  'TEST',
];

function readTypeFilter() {
  const raw = (process.env.NOTIFY_EVENT_TYPES || '').trim();
  if (!raw) return new Set(DEFAULT_TYPES);
  if (raw === '*' || raw.toLowerCase() === 'all') return null; // null == allow all
  return new Set(
    raw
      .split(/[\s,]+/)
      .map((s) => s.toUpperCase().trim())
      .filter(Boolean)
  );
}

function readMaxAgeMs() {
  const min = Number(process.env.NOTIFY_MAX_EVENT_AGE_MINUTES);
  const v = Number.isFinite(min) && min > 0 ? min : 60;
  return v * 60 * 1000;
}

function readSandboxAllowed() {
  return /^(1|true|yes)$/i.test(process.env.NOTIFY_INCLUDE_SANDBOX || 'true');
}

function readShowDailyTotal() {
  return /^(1|true|yes)$/i.test(process.env.NOTIFY_SHOW_DAILY_TOTAL || 'true');
}

function shouldNotify(event) {
  if (!event) return false;

  const filter = readTypeFilter();
  if (filter && !filter.has(event.type)) return false;

  const sandbox = (event.environment || '').toUpperCase() === 'SANDBOX';
  if (sandbox && !readSandboxAllowed()) return false;

  const maxAge = readMaxAgeMs();
  if (maxAge > 0 && event.event_timestamp_ms) {
    const age = Date.now() - event.event_timestamp_ms;
    if (age > maxAge) return false;
  }
  return true;
}

function todayNetUsdFor(appId) {
  try {
    const row = analytics.daily(1, appId || null)[0];
    return row ? row.net_revenue : 0;
  } catch {
    return 0;
  }
}

async function handleIngestedEvent({ event }) {
  if (!telegram.isConfigured()) return;
  if (!shouldNotify(event)) return;

  const app = getAppById(event.app_id);
  const showTotal = readShowDailyTotal();
  const dailyTotalUsd = showTotal ? todayNetUsdFor(event.app_id) : null;

  const text = formatEventMessage({ event, app, dailyTotalUsd });

  // REFUND/BILLING are higher signal — make sure they ring even if user has
  // muted normal renewals at the OS level. We do this by NOT setting silent.
  // Other events fall back to default (sound on, but easily mutable per chat).
  await telegram.sendMessage(text, { silent: false }).catch(() => {});
}

// ---------------- daily digest ----------------

function readDigestEnabled() {
  return /^(1|true|yes)$/i.test(process.env.NOTIFY_DAILY_DIGEST_ENABLED || 'true');
}

function readDigestHourUtc() {
  const h = Number(process.env.NOTIFY_DAILY_DIGEST_UTC_HOUR);
  if (!Number.isFinite(h) || h < 0 || h > 23) return 6; // 06:00 UTC ≈ 09:00 İstanbul
  return Math.floor(h);
}

function nextRunAt(hourUtc) {
  const now = new Date();
  const target = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    hourUtc,
    0,
    0,
    0
  ));
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target;
}

async function sendDigestForYesterday() {
  if (!telegram.isConfigured()) return;

  // analytics.daily(2)[0] is yesterday in UTC, [1] is today. We summarise
  // yesterday because the day is fully closed.
  const days = analytics.daily(2);
  const yesterday = days[0];
  if (!yesterday) return;

  const apps = getApps();
  let byApp = null;
  if (apps.length > 1) {
    try {
      const ba = analytics.dailyByApp(2);
      byApp = ba?.rows?.[0]?.by_app || null;
    } catch {
      byApp = null;
    }
  }

  const text = formatDailyDigest({
    dateLabel: yesterday.date,
    daily: yesterday,
    byApp,
    apps: apps.map((a) => ({ id: a.id, name: a.name })),
  });

  await telegram.sendMessage(text, { silent: false }).catch(() => {});
}

let _digestTimer = null;
function scheduleDigest() {
  if (_digestTimer) clearTimeout(_digestTimer);
  if (!readDigestEnabled()) return;

  const hourUtc = readDigestHourUtc();
  const at = nextRunAt(hourUtc);
  const delay = at.getTime() - Date.now();

  _digestTimer = setTimeout(async () => {
    try {
      await sendDigestForYesterday();
    } catch (err) {
      console.warn('[notify][digest] failed:', err.message);
    } finally {
      // Chain the next run.
      scheduleDigest();
    }
  }, delay);

  console.log(
    `[notify] daily digest scheduled at ${at.toISOString()} (UTC ${hourUtc}:00)`
  );
}

// ---------------- entrypoint ----------------

let _started = false;

export function startNotifyService() {
  if (_started) return;
  _started = true;

  const cfg = telegram.configStatus();
  if (!cfg.enabled) {
    console.log(
      '[notify] Telegram disabled (set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to enable).'
    );
    return;
  }

  const types = readTypeFilter();
  console.log(
    `[notify] Telegram enabled · types=${types ? Array.from(types).join(',') : 'all'} · max_age=${readMaxAgeMs() / 60000}m · sandbox=${readSandboxAllowed()}`
  );

  on('event', (payload) => {
    handleIngestedEvent(payload).catch((err) => {
      console.warn('[notify] handler failed:', err.message);
    });
  });

  scheduleDigest();
}

/** Manual trigger — useful from API endpoints / scripts. */
export async function sendDailyDigestNow() {
  await sendDigestForYesterday();
}

/** Send a small "hello" from the bot. Used for `npm run notify:test`. */
export async function sendBootPing() {
  if (!telegram.isConfigured()) {
    return { ok: false, error: 'telegram_not_configured' };
  }
  const apps = getApps();
  const lines = [
    '✅ <b>Revenue Pulse · Telegram bağlantısı aktif</b>',
    `Apps: <b>${apps.length}</b>${apps.length ? ` (${apps.map((a) => a.name).join(', ')})` : ''}`,
    `Today (all): <b>${formatUsd(analytics.daily(1)[0]?.net_revenue || 0)}</b>`,
  ];
  await telegram.sendMessage(lines.join('\n'));
  return { ok: true };
}
