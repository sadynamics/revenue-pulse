/**
 * Formatting helpers for outbound notification messages.
 *
 * The output format is intentionally Telegram-flavoured (HTML parse mode) but
 * the helpers themselves are channel-agnostic where possible.
 */

/** ISO 3166-1 alpha-3 → alpha-2 for the codes Apple commonly returns. */
const A3_TO_A2 = {
  USA: 'US', GBR: 'GB', DEU: 'DE', FRA: 'FR', ESP: 'ES', ITA: 'IT', NLD: 'NL',
  SWE: 'SE', NOR: 'NO', DNK: 'DK', FIN: 'FI', POL: 'PL', PRT: 'PT', IRL: 'IE',
  BEL: 'BE', AUT: 'AT', CHE: 'CH', GRC: 'GR', CZE: 'CZ', HUN: 'HU', ROU: 'RO',
  BGR: 'BG', UKR: 'UA', RUS: 'RU', TUR: 'TR',
  JPN: 'JP', KOR: 'KR', CHN: 'CN', HKG: 'HK', TWN: 'TW', SGP: 'SG', MYS: 'MY',
  IDN: 'ID', PHL: 'PH', VNM: 'VN', THA: 'TH', IND: 'IN', PAK: 'PK', BGD: 'BD',
  LKA: 'LK', NPL: 'NP',
  CAN: 'CA', MEX: 'MX', BRA: 'BR', ARG: 'AR', CHL: 'CL', COL: 'CO', PER: 'PE',
  VEN: 'VE', URY: 'UY',
  AUS: 'AU', NZL: 'NZ',
  ZAF: 'ZA', EGY: 'EG', NGA: 'NG', KEN: 'KE', MAR: 'MA', DZA: 'DZ',
  ARE: 'AE', SAU: 'SA', QAT: 'QA', KWT: 'KW', ISR: 'IL', JOR: 'JO', LBN: 'LB',
  IRN: 'IR', IRQ: 'IQ',
};

/** Country code → 🇺🇸. Accepts alpha-2 or alpha-3. Returns '' if unknown. */
export function countryFlag(cc) {
  if (!cc) return '';
  let code = String(cc).toUpperCase().trim();
  if (code.length === 3) code = A3_TO_A2[code] || code.slice(0, 2);
  if (!/^[A-Z]{2}$/.test(code)) return '';
  // Regional Indicator Symbols (U+1F1E6 == 'A')
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)
  );
}

/** Coarse "x ago" suitable for push title lines. */
export function timeAgo(ms) {
  const d = Date.now() - ms;
  if (!Number.isFinite(d) || d < 0) return 'just now';
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

/** Minimal HTML escape — Telegram only honours &lt; &gt; &amp;. */
export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** USD amount → "$9.99" / "-$4.50" / "$1,234.00". */
export function formatUsd(n, { signed = false } = {}) {
  const v = Number(n) || 0;
  const abs = Math.abs(v);
  const fmt = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (signed && v < 0) return `-$${fmt}`;
  if (signed && v > 0) return `+$${fmt}`;
  return v < 0 ? `-$${fmt}` : `$${fmt}`;
}

/**
 * Per-event-type display metadata. Keep short — the badge appears next to the
 * app name in the title row.
 */
const EVENT_META = {
  INITIAL_PURCHASE:        { emoji: '🎉', badge: 'NEW',          severity: 'success', revenue: 'gain'    },
  RENEWAL:                 { emoji: '🔁', badge: 'RENEWAL',      severity: 'success', revenue: 'gain'    },
  NON_RENEWING_PURCHASE:   { emoji: '🛒', badge: 'PURCHASE',     severity: 'success', revenue: 'gain'    },
  PRODUCT_CHANGE:          { emoji: '🔀', badge: 'PLAN CHANGE',  severity: 'info',    revenue: 'neutral' },
  UNCANCELLATION:          { emoji: '💚', badge: 'RESUBSCRIBED', severity: 'success', revenue: 'neutral' },
  CANCELLATION:            { emoji: '⚠️', badge: 'AUTO-RENEW OFF', severity: 'warning', revenue: 'neutral' },
  EXPIRATION:              { emoji: '⛔️', badge: 'EXPIRED',      severity: 'warning', revenue: 'neutral' },
  BILLING_ISSUE:           { emoji: '💳', badge: 'BILLING',      severity: 'danger',  revenue: 'neutral' },
  SUBSCRIPTION_PAUSED:     { emoji: '⏸️', badge: 'PAUSED',       severity: 'warning', revenue: 'neutral' },
  REFUND:                  { emoji: '↩️', badge: 'REFUND',       severity: 'danger',  revenue: 'loss'    },
  REVOKE:                  { emoji: '🚫', badge: 'REVOKED',      severity: 'danger',  revenue: 'loss'    },
  SUBSCRIPTION_EXTENDED:   { emoji: '⏩', badge: 'EXTENDED',     severity: 'info',    revenue: 'neutral' },
  PRICE_INCREASE_CONSENT:  { emoji: '💲', badge: 'PRICE +',      severity: 'info',    revenue: 'neutral' },
  TRANSFER:                { emoji: '🔁', badge: 'TRANSFER',     severity: 'info',    revenue: 'neutral' },
  TEMPORARY_ENTITLEMENT_GRANT: { emoji: '🎁', badge: 'GRANT',    severity: 'info',    revenue: 'neutral' },
  TEST:                    { emoji: '🧪', badge: 'TEST',         severity: 'info',    revenue: 'neutral' },
};

export function eventMeta(type) {
  return EVENT_META[type] || { emoji: '•', badge: type, severity: 'info', revenue: 'neutral' };
}

/** Short, anonymised user handle for the message body. */
function shortUser(id) {
  if (!id) return '—';
  const s = String(id);
  if (s.length <= 12) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}

/**
 * Build a Telegram-HTML message for a single ingested event.
 *
 * Output style (one event = one message), inspired by RevenueCat's mobile
 * transactions screen:
 *
 *   🇺🇸 <b>weekly-torq</b>  $9.99  · RENEWAL
 *   <i>Torq · App Store · 1h ago</i>
 *   👤 <code>abc123…0042</code>
 *   <i>com.acme.weekly</i>
 */
export function formatEventMessage({ event, app, dailyTotalUsd = null }) {
  const meta = eventMeta(event.type);
  const flag = countryFlag(event.country_code);
  const product = event.product_id || '—';
  const appName = app?.name || event.app_id || '—';
  const bundle = app?.bundle_id || '—';
  const envIsSandbox = (event.environment || '').toUpperCase() === 'SANDBOX';

  const isLoss = meta.revenue === 'loss';
  const amount = event.price_usd
    ? formatUsd(isLoss ? -Math.abs(event.price_usd) : event.price_usd)
    : '';

  const head = [
    flag || '🌐',
    `<b>${escapeHtml(product)}</b>`,
    amount ? `<code>${escapeHtml(amount)}</code>` : '',
    `· ${meta.emoji} <b>${escapeHtml(meta.badge)}</b>`,
  ]
    .filter(Boolean)
    .join(' ');

  const subline = [
    escapeHtml(appName),
    'App Store',
    timeAgo(event.event_timestamp_ms),
    envIsSandbox ? 'SANDBOX' : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = [head, `<i>${subline}</i>`];

  if (event.app_user_id) {
    lines.push(`👤 <code>${escapeHtml(shortUser(event.app_user_id))}</code>`);
  }

  if (event.cancel_reason) {
    lines.push(`💬 <i>${escapeHtml(event.cancel_reason)}</i>`);
  } else if (event.expiration_reason) {
    lines.push(`💬 <i>${escapeHtml(event.expiration_reason)}</i>`);
  }

  if (bundle && bundle !== '—') {
    lines.push(`<i>${escapeHtml(bundle)}</i>`);
  }

  if (dailyTotalUsd != null) {
    lines.push(
      `\n<i>Today: ${escapeHtml(formatUsd(dailyTotalUsd))} net</i>`
    );
  }

  return lines.join('\n');
}

/**
 * Build the daily digest message.
 *
 * `daily` is the row produced by analytics.daily(1) for the digest day, and
 * `byApp` is the row produced by analytics.dailyByApp(2).rows[i].by_app for
 * the same day. `apps` is the public app list to provide names.
 */
export function formatDailyDigest({ dateLabel, daily, byApp, apps }) {
  const totalNet = daily.net_revenue;
  const sign =
    totalNet > 0 ? '📈'
    : totalNet < 0 ? '📉'
    : '➖';

  const lines = [];
  lines.push(`${sign} <b>Daily summary — ${escapeHtml(dateLabel)}</b>`);
  lines.push('');
  lines.push(`💵 Net revenue: <b>${escapeHtml(formatUsd(totalNet))}</b>`);
  lines.push(
    `   Production: ${escapeHtml(formatUsd(daily.production_net_revenue))} · Sandbox: ${escapeHtml(formatUsd(daily.sandbox_net_revenue))}`
  );
  if (daily.refunds > 0) {
    lines.push(
      `   Gross: ${escapeHtml(formatUsd(daily.revenue))} · Refunds: ${escapeHtml(formatUsd(-daily.refunds))}`
    );
  }

  if (apps && apps.length > 1 && byApp) {
    lines.push('');
    lines.push('<b>By app</b>');
    const sorted = [...apps].sort((a, b) => {
      const aNet = byApp[a.id]?.net || 0;
      const bNet = byApp[b.id]?.net || 0;
      return bNet - aNet;
    });
    for (const a of sorted) {
      const v = byApp[a.id] || { net: 0 };
      const net = v.net || 0;
      if (net === 0 && (v.revenue || 0) === 0 && (v.refunds || 0) === 0) continue;
      lines.push(
        `   • ${escapeHtml(a.name)}: <b>${escapeHtml(formatUsd(net))}</b>`
      );
    }
  }

  lines.push('');
  lines.push('<b>Activity</b>');
  const refundLabel =
    daily.refunds > 0 ? ` ${escapeHtml(formatUsd(-daily.refunds))}` : '';
  lines.push(
    `   🆕 New: <b>${daily.new_subs}</b>  🔁 Renewals: <b>${daily.renewals}</b>  ↩️ Refunds:${refundLabel}`
  );
  lines.push(
    `   ⛔️ Churn: <b>${daily.churned}</b>  ⚠️ Cancellations: <b>${daily.cancellations}</b>`
  );

  return lines.join('\n');
}
