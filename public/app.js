// Revenue Pulse Dashboard — Vanilla ES Module
// Pages: overview, subscribers, events, renewals, churn, products, geography, debug

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const fmtMoney = (n, d = 2) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtNum = (n) => (Number(n) || 0).toLocaleString('en-US');
const fmtPct = (n, d = 1) => (n == null ? '—' : (Number(n).toFixed(d) + '%'));
const fmtDate = (ms) => ms ? new Date(ms).toLocaleString() : '—';
const fmtRel = (ms) => {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};
const fmtCountdown = (ms) => {
  if (!ms) return '—';
  const diff = ms - Date.now();
  if (diff < 0) return 'expired';
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  return `${d}d ${h}h`;
};
const truncate = (s, n = 12) => (!s ? '' : (s.length > n ? s.slice(0, n) + '…' : s));
const boolBadge = (v) => (v == null ? '—' : (v ? '<span class="badge badge-ok">yes</span>' : '<span class="badge badge-warn">no</span>'));

// Event type styles
const EVT_META = {
  INITIAL_PURCHASE:       { label: 'New',           cls: 'badge-ok'      },
  RENEWAL:                { label: 'Renewal',       cls: 'badge-ok'      },
  NON_RENEWING_PURCHASE:  { label: 'One-time',      cls: 'badge-info'    },
  PRODUCT_CHANGE:         { label: 'Plan change',   cls: 'badge-info'    },
  UNCANCELLATION:         { label: 'Resubscribed',  cls: 'badge-ok'      },
  CANCELLATION:           { label: 'Cancelled',     cls: 'badge-warn'    },
  EXPIRATION:             { label: 'Expired',       cls: 'badge-warn'    },
  BILLING_ISSUE:          { label: 'Billing issue', cls: 'badge-bad'     },
  SUBSCRIPTION_PAUSED:    { label: 'Paused',        cls: 'badge-warn'    },
  REFUND:                 { label: 'Refund',        cls: 'badge-bad'     },
  SUBSCRIPTION_EXTENDED:  { label: 'Extended',      cls: 'badge-info'    },
  TRANSFER:               { label: 'Transfer',      cls: 'badge-info'    },
  TEST:                   { label: 'Test',          cls: 'badge-neutral' },
};
const evBadge = (type) => {
  const m = EVT_META[type] || { label: type, cls: 'badge-neutral' };
  return `<span class="badge ${m.cls}">${m.label}</span>`;
};

// ============================================================
// APP SELECTION (multi-app support)
// ============================================================

const STATE = {
  appId: localStorage.getItem('rp.app_id') || '', // '' means "all apps"
  apps: [],
};

/** Append the currently selected app_id (if any) to a path. */
function withAppId(path) {
  if (!STATE.appId) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}app_id=${encodeURIComponent(STATE.appId)}`;
}

// API helpers
async function api(path) {
  const r = await fetch('/api' + withAppId(path));
  if (!r.ok) throw new Error(`API ${path} → ${r.status}`);
  return r.json();
}

/** POST helper that includes app_id both as query param and (for JSON bodies) in the body. */
async function apiPost(path, body = {}) {
  const finalBody = (body && typeof body === 'object' && !Array.isArray(body))
    ? { ...(STATE.appId ? { app_id: STATE.appId } : {}), ...body }
    : body;
  const r = await fetch('/api' + withAppId(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(finalBody),
  });
  return r.json();
}

async function loadApps() {
  try {
    const data = await fetch('/api/apps').then(r => r.json());
    STATE.apps = data.apps || [];
    const sel = $('#app-select');
    if (!sel) return;
    sel.innerHTML = `<option value="">All apps</option>` +
      STATE.apps
        .map(a => `<option value="${a.id}">${a.name} · ${a.bundle_id} (${a.environment})</option>`)
        .join('');

    // Validate persisted selection still exists; otherwise reset.
    if (STATE.appId && !STATE.apps.some(a => a.id === STATE.appId)) {
      STATE.appId = '';
      localStorage.removeItem('rp.app_id');
    }
    sel.value = STATE.appId;

    // Hide selector entirely when ≤1 app is configured (less clutter).
    sel.parentElement.style.display = STATE.apps.length > 1 ? '' : 'none';
  } catch (err) {
    console.warn('Failed to load apps:', err.message);
  }
}

// Chart palette
const PALETTE = ['#7c5cff','#22c55e','#f59e0b','#ef4444','#3b82f6','#ec4899','#14b8a6','#eab308','#a855f7','#f97316'];
Chart.defaults.color = '#9ca3c4';
Chart.defaults.borderColor = '#2a2f4477';
Chart.defaults.font.family = "'Inter', ui-sans-serif, system-ui";

let charts = {};
function destroyCharts() {
  Object.values(charts).forEach(c => c && c.destroy());
  charts = {};
}

// ============================================================
// PAGES
// ============================================================

async function renderOverview() {
  setTitle('Overview', 'Realtime KPIs across your subscriptions');

  const showPerApp = !STATE.appId && STATE.apps.length > 1;
  const summaryReq   = api('/summary');
  const notifsReq    = api('/notifications?limit=15');
  const breakdownReq = showPerApp
    ? fetch('/api/daily-by-app?days=30').then(r => r.json()).catch(() => null)
    : Promise.resolve(null);
  const [s, notifs, breakdown] = await Promise.all([summaryReq, notifsReq, breakdownReq]);

  const k = s.kpis;
  const prodNet30 = s.daily.reduce((sum, d) => sum + (d.production_net_revenue || 0), 0);
  const sandboxNet30 = s.daily.reduce((sum, d) => sum + (d.sandbox_net_revenue || 0), 0);

  $('#page').innerHTML = `
    <!-- KPI grid -->
    <section class="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
      ${kpiCard('MRR',              fmtMoney(k.mrr),      k.new_subs_growth_pct)}
      ${kpiCard('ARR',              fmtMoney(k.arr, 0))}
      ${kpiCard('Active subs',      fmtNum(k.active_subscribers))}
      ${kpiCard('Trials',           fmtNum(k.trial_subscribers))}
      ${kpiCard('Churn 30d',        fmtPct(k.churn_rate_30d_pct, 2))}
      ${kpiCard('Trial conv.',      fmtPct(k.trial_conversion_pct, 1))}
    </section>

    <section class="grid grid-cols-2 md:grid-cols-4 gap-4">
      ${kpiCard('Revenue 30d',      fmtMoney(k.revenue_30d))}
      ${kpiCard('Refunds 30d',      fmtMoney(k.refunds_30d))}
      ${kpiCard('Net rev. 30d',     fmtMoney(k.net_revenue_30d))}
      ${kpiCard('Avg LTV',          fmtMoney(k.avg_ltv_usd))}
    </section>
    <section class="grid grid-cols-2 md:grid-cols-4 gap-4">
      ${kpiCard('Prod net 30d',     fmtMoney(prodNet30))}
      ${kpiCard('Sandbox net 30d',  fmtMoney(sandboxNet30))}
    </section>

    <!-- Charts -->
    <section class="grid grid-cols-1 xl:grid-cols-3 gap-6">
      <div class="card xl:col-span-2">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold">MRR (30 days)</h3>
          <span class="text-xs text-ink-400">USD, normalized monthly</span>
        </div>
        <div class="h-64"><canvas id="mrrChart"></canvas></div>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Daily revenue vs refunds</h3>
        <div class="h-64"><canvas id="revenueChart"></canvas></div>
      </div>
    </section>

    <!-- Daily revenue breakdown (numeric) -->
    <section class="card">
      <div class="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <h3 class="font-semibold">Daily revenue breakdown (last 30 days)</h3>
          <div class="text-xs text-ink-400 mt-0.5">${dailyBreakdownSubtitle(s.daily, breakdown)}</div>
        </div>
        <div class="text-xs text-ink-400">${
          showPerApp
            ? 'Showing all apps — switch to a single app via the App selector for a focused view.'
            : (STATE.appId
                ? `Filtered to <span class="text-ink-100">${escapeHtml(currentAppLabel())}</span>`
                : 'Net = revenue − refunds')
        }</div>
      </div>
      ${renderDailyBreakdown(s.daily, breakdown)}
    </section>

    <section class="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <div class="card">
        <h3 class="font-semibold mb-3">New subscribers vs churn (30d)</h3>
        <div class="h-64"><canvas id="growthChart"></canvas></div>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Active subscribers trend</h3>
        <div class="h-64"><canvas id="activeChart"></canvas></div>
      </div>
    </section>

    <!-- Live feed + upcoming renewals -->
    <section class="grid grid-cols-1 xl:grid-cols-3 gap-6">
      <div class="card xl:col-span-2">
        <div class="flex items-center justify-between mb-3">
          <h3 class="font-semibold">Live activity</h3>
          <span class="text-xs text-ink-400">Auto-updates via SSE</span>
        </div>
        <div id="live-feed" class="space-y-2 max-h-[420px] overflow-y-auto">
          ${notifs.map(renderNotifRow).join('') || emptyState('No events yet')}
        </div>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Upcoming renewals (7d)</h3>
        <div class="space-y-2 max-h-[420px] overflow-y-auto">
          ${s.upcoming_renewals.length ? s.upcoming_renewals.map(r => `
            <div class="flex items-center justify-between p-2 rounded-lg hover:bg-ink-800 cursor-pointer" onclick="location.hash='#subscribers?u=${encodeURIComponent(r.app_user_id)}'">
              <div class="min-w-0">
                <div class="text-sm font-medium truncate">${r.app_user_id}</div>
                <div class="text-xs text-ink-400">${r.current_product_id} · ${r.period_type || ''}</div>
              </div>
              <div class="text-right shrink-0 ml-2">
                <div class="text-sm font-semibold">${fmtMoney(r.current_price_usd)}</div>
                <div class="text-xs text-ink-400">${fmtCountdown(r.expiration_ms)}</div>
              </div>
            </div>`).join('') : emptyState('No renewals in next 7 days')}
        </div>
      </div>
    </section>

    <!-- Top subscribers -->
    <section class="card">
      <h3 class="font-semibold mb-3">Top subscribers by LTV</h3>
      <table class="table">
        <thead><tr>
          <th>User</th><th>Product</th><th>Status</th><th>Country</th><th>Renewals</th><th class="text-right">LTV</th>
        </tr></thead>
        <tbody>
          ${s.top_subscribers.map(u => `
            <tr class="cursor-pointer" onclick="location.hash='#subscribers?u=${encodeURIComponent(u.app_user_id)}'">
              <td class="font-mono text-xs">${truncate(u.app_user_id, 22)}</td>
              <td>${u.current_product_id || '—'}</td>
              <td>${statusBadge(u.status)}</td>
              <td>${u.country_code || '—'}</td>
              <td>${u.renewals_count}</td>
              <td class="text-right font-semibold">${fmtMoney(u.ltv_usd)}</td>
            </tr>`).join('') || `<tr><td colspan="6">${emptyState('No subscribers')}</td></tr>`}
        </tbody>
      </table>
    </section>
  `;

  drawMrr(s.mrr_history);
  drawRevenueDaily(s.daily);
  drawGrowthDaily(s.daily);
  drawActiveTrend(s.mrr_history);
}

async function renderSubscribers() {
  setTitle('Subscribers', 'All users and their subscription lifecycle');

  $('#page').innerHTML = `
    <section class="card">
      <div class="flex flex-wrap gap-3 items-center mb-4">
        <input id="sub-q" type="search" placeholder="Search app_user_id…" class="flex-1 min-w-64" />
        <select id="sub-status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="expired">Expired</option>
          <option value="billing_issue">Billing issue</option>
        </select>
        <button id="sub-refresh" class="btn-ghost text-sm">↻</button>
      </div>
      <div id="sub-table"></div>
    </section>
  `;

  const load = async () => {
    const q = $('#sub-q').value.trim();
    const status = $('#sub-status').value;
    const data = await api(`/subscribers?limit=100&q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
    $('#sub-table').innerHTML = renderSubscribersTable(data);
  };

  $('#sub-q').addEventListener('input', debounce(load, 250));
  $('#sub-status').addEventListener('change', load);
  $('#sub-refresh').addEventListener('click', load);
  await load();

  // Deep link — ?u=<id>
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  if (params.get('u')) openSubscriber(params.get('u'));
}

function renderSubscribersTable({ total, items }) {
  if (!items.length) return emptyState('No subscribers match your filters');
  return `
    <div class="text-xs text-ink-400 mb-2">${fmtNum(total)} subscribers</div>
    <table class="table">
      <thead><tr>
        <th>User</th><th>Status</th><th>Product</th><th>Period</th><th>Country</th>
        <th>Renewals</th><th class="text-right">LTV</th><th>Expires</th><th>Last event</th>
      </tr></thead>
      <tbody>
        ${items.map(s => `
          <tr class="cursor-pointer" data-user="${s.app_user_id}">
            <td class="font-mono text-xs">${truncate(s.app_user_id, 24)}</td>
            <td>${statusBadge(s.status)}${s.will_renew === 0 ? ' <span class="badge badge-warn">won\'t renew</span>' : ''}</td>
            <td>${s.current_product_id || '—'}</td>
            <td>${s.period_type || '—'}</td>
            <td>${s.country_code || '—'}</td>
            <td>${s.renewals_count || 0}</td>
            <td class="text-right font-semibold">${fmtMoney(s.ltv_usd)}</td>
            <td class="text-ink-400">${fmtCountdown(s.expiration_ms)}</td>
            <td class="text-ink-400">${fmtRel(s.last_event_ms)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

async function renderEvents() {
  setTitle('Events', 'All webhook events received from RevenueCat');

  $('#page').innerHTML = `
    <section class="card">
      <div class="flex flex-wrap gap-3 items-center mb-4">
        <select id="ev-type">
          <option value="all">All types</option>
          ${Object.keys(EVT_META).map(t => `<option value="${t}">${EVT_META[t].label} (${t})</option>`).join('')}
        </select>
        <button id="ev-refresh" class="btn-ghost text-sm">↻</button>
      </div>
      <div id="ev-table"></div>
    </section>
  `;

  const load = async () => {
    const type = $('#ev-type').value;
    const data = await api(`/events?limit=200&type=${encodeURIComponent(type)}`);
    $('#ev-table').innerHTML = renderEventsTable(data);
  };

  $('#ev-type').addEventListener('change', load);
  $('#ev-refresh').addEventListener('click', load);
  await load();
}

function renderEventsTable({ total, items }) {
  if (!items.length) return emptyState('No events');
  return `
    <div class="text-xs text-ink-400 mb-2">${fmtNum(total)} events</div>
    <table class="table">
      <thead><tr>
        <th>When</th><th>Type</th><th>User</th><th>Product</th><th>Period</th><th>Country</th><th>Store</th><th class="text-right">Amount</th>
      </tr></thead>
      <tbody>
        ${items.map(e => `
          <tr class="cursor-pointer" onclick="location.hash='#subscribers?u=${encodeURIComponent(e.app_user_id || '')}'">
            <td class="text-ink-400">${fmtRel(e.event_timestamp_ms)}</td>
            <td>${evBadge(e.type)}</td>
            <td class="font-mono text-xs">${truncate(e.app_user_id || '—', 18)}</td>
            <td>${e.product_id || '—'}</td>
            <td>${e.period_type || '—'}</td>
            <td>${e.country_code || '—'}</td>
            <td>${e.store || '—'}</td>
            <td class="text-right font-semibold">${e.price_usd ? fmtMoney(e.price_usd) : '—'}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

async function renderRenewals() {
  setTitle('Renewals', 'Full renewal history and revenue per cycle');
  const data = await api('/renewals?limit=300');
  $('#page').innerHTML = `
    <section class="grid grid-cols-4 gap-4">
      ${kpiCard('Total renewals', fmtNum(data.total))}
      ${kpiCard('Shown', fmtNum(data.items.length))}
      ${kpiCard('Renewal revenue', fmtMoney(data.items.reduce((s, i) => s + (i.price_usd || 0), 0)))}
      ${kpiCard('Avg value', fmtMoney(data.items.length ? data.items.reduce((s, i) => s + (i.price_usd || 0), 0) / data.items.length : 0))}
    </section>
    <section class="card">
      <table class="table">
        <thead><tr>
          <th>When</th><th>User</th><th>Product</th><th>Period</th><th>Country</th><th>Store</th><th>Next expiry</th><th class="text-right">Amount</th>
        </tr></thead>
        <tbody>
          ${data.items.map(e => `
            <tr class="cursor-pointer" onclick="location.hash='#subscribers?u=${encodeURIComponent(e.app_user_id || '')}'">
              <td class="text-ink-400">${fmtRel(e.event_timestamp_ms)}</td>
              <td class="font-mono text-xs">${truncate(e.app_user_id, 20)}</td>
              <td>${e.product_id}</td>
              <td>${e.period_type || '—'}</td>
              <td>${e.country_code || '—'}</td>
              <td>${e.store || '—'}</td>
              <td class="text-ink-400">${fmtDate(e.expiration_at_ms)}</td>
              <td class="text-right font-semibold">${fmtMoney(e.price_usd)}</td>
            </tr>`).join('') || `<tr><td colspan="8">${emptyState('No renewals yet')}</td></tr>`}
        </tbody>
      </table>
    </section>
  `;
}

async function renderChurn() {
  setTitle('Churn', 'Understand why subscribers are leaving');
  const [reasons, daily] = await Promise.all([api('/churn-reasons'), api('/daily?days=90')]);

  $('#page').innerHTML = `
    <section class="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <div class="card">
        <h3 class="font-semibold mb-3">Cancellation & churn reasons (90d)</h3>
        <div class="h-72"><canvas id="reasonsChart"></canvas></div>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Daily churn (90d)</h3>
        <div class="h-72"><canvas id="churnDailyChart"></canvas></div>
      </div>
    </section>

    <section class="card">
      <h3 class="font-semibold mb-3">Reason breakdown</h3>
      <table class="table">
        <thead><tr><th>Reason</th><th class="text-right">Count</th></tr></thead>
        <tbody>
          ${reasons.map(r => `<tr><td>${r.reason}</td><td class="text-right font-semibold">${r.count}</td></tr>`).join('') || `<tr><td colspan="2">${emptyState('No churn data yet')}</td></tr>`}
        </tbody>
      </table>
    </section>
  `;

  charts.reasons = new Chart($('#reasonsChart'), {
    type: 'doughnut',
    data: {
      labels: reasons.map(r => r.reason),
      datasets: [{ data: reasons.map(r => r.count), backgroundColor: PALETTE, borderWidth: 0 }]
    },
    options: { plugins: { legend: { position: 'bottom' } }, cutout: '60%' }
  });

  charts.churnDaily = new Chart($('#churnDailyChart'), {
    type: 'bar',
    data: {
      labels: daily.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Churned',      data: daily.map(d => d.churned),      backgroundColor: '#ef4444' },
        { label: 'Cancellations', data: daily.map(d => d.cancellations), backgroundColor: '#f59e0b' },
      ]
    },
    options: chartBaseOpts({ stacked: true })
  });
}

async function renderProducts() {
  setTitle('Products', 'Revenue and subscriber distribution by product');
  const [products, stores] = await Promise.all([api('/products'), api('/stores')]);

  $('#page').innerHTML = `
    <section class="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <div class="card">
        <h3 class="font-semibold mb-3">Active subscribers by product</h3>
        <div class="h-72"><canvas id="productsChart"></canvas></div>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Subscribers by store</h3>
        <div class="h-72"><canvas id="storesChart"></canvas></div>
      </div>
    </section>
    <section class="card">
      <h3 class="font-semibold mb-3">Product breakdown</h3>
      <table class="table">
        <thead><tr><th>Product</th><th>Subscribers</th><th>Avg price</th><th class="text-right">Gross (monthly)</th></tr></thead>
        <tbody>
          ${products.map(p => `
            <tr><td class="font-medium">${p.product_id}</td>
                <td>${fmtNum(p.subscribers)}</td>
                <td>${fmtMoney(p.avg_price_usd)}</td>
                <td class="text-right font-semibold">${fmtMoney(p.gross_usd)}</td></tr>`).join('')
             || `<tr><td colspan="4">${emptyState('No products yet')}</td></tr>`}
        </tbody>
      </table>
    </section>
  `;

  charts.products = new Chart($('#productsChart'), {
    type: 'bar',
    data: {
      labels: products.map(p => p.product_id),
      datasets: [{ label: 'Subscribers', data: products.map(p => p.subscribers), backgroundColor: '#7c5cff' }]
    },
    options: { ...chartBaseOpts(), indexAxis: 'y' }
  });

  charts.stores = new Chart($('#storesChart'), {
    type: 'doughnut',
    data: {
      labels: stores.map(s => s.store),
      datasets: [{ data: stores.map(s => s.subscribers), backgroundColor: PALETTE, borderWidth: 0 }]
    },
    options: { plugins: { legend: { position: 'bottom' } }, cutout: '60%' }
  });
}

async function renderGeography() {
  setTitle('Geography', 'Where your subscribers live');
  const countries = await api('/countries');

  $('#page').innerHTML = `
    <section class="card">
      <h3 class="font-semibold mb-3">Top countries by active subscribers</h3>
      <div class="h-80"><canvas id="countryChart"></canvas></div>
    </section>
    <section class="card">
      <h3 class="font-semibold mb-3">Country breakdown</h3>
      <table class="table">
        <thead><tr><th>Country</th><th>Subscribers</th><th class="text-right">Revenue (LTV sum)</th></tr></thead>
        <tbody>
          ${countries.map(c => `<tr><td>${flag(c.country)} ${c.country}</td><td>${fmtNum(c.subscribers)}</td><td class="text-right font-semibold">${fmtMoney(c.revenue_usd)}</td></tr>`).join('')
            || `<tr><td colspan="3">${emptyState('No country data')}</td></tr>`}
        </tbody>
      </table>
    </section>
  `;

  charts.countries = new Chart($('#countryChart'), {
    type: 'bar',
    data: {
      labels: countries.map(c => c.country),
      datasets: [{ label: 'Subscribers', data: countries.map(c => c.subscribers), backgroundColor: '#22c55e' }]
    },
    options: { ...chartBaseOpts(), indexAxis: 'y' }
  });
}

async function renderDebug() {
  setTitle('Webhook Debug', 'Test App Store Server Notifications V2 integration');

  const cfg = await api('/config').catch(() => ({}));

  const appsList = (cfg.apps || []).map(a =>
    `<span class="badge ${a.api_configured ? 'badge-ok' : 'badge-warn'}">${a.id} · ${a.bundle_id} (${a.environment})${a.api_configured ? '' : ' · no API key'}</span>`
  ).join(' ');

  $('#page').innerHTML = `
    <section class="card mb-6">
      <div class="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h3 class="font-semibold mb-1">App Store Server API</h3>
          <div class="text-xs text-ink-400">
            ${cfg.appstore_api_configured
              ? `<span class="text-emerald-400">●</span> Configured · ${cfg.selected_app_id ? `app=${cfg.selected_app_id}` : `default=${cfg.default_app_id}`} · ${cfg.environment || 'Production'} · ${cfg.bundle_id || ''}`
              : `<span class="text-rose-400">●</span> Not configured for this app — set APPS_CONFIG (JSON) or legacy APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_BUNDLE_ID`}
          </div>
          ${appsList ? `<div class="text-xs text-ink-400 mt-2 flex flex-wrap gap-2">${appsList}</div>` : ''}
          <div class="text-xs text-ink-400 mt-2">
            Used to backfill historical purchases (renewals, refunds, lifetime, consumables) for users seen via webhook.
            New users are auto-backfilled in the background. You can also trigger a sync per-user from the Subscribers list, or backfill everything via <code>npm run backfill</code>.
          </div>
        </div>
        <button id="backfill-all-btn" class="btn-ghost text-sm" ${cfg.appstore_api_configured ? '' : 'disabled'} title="Backfill every user currently in the DB">
          🔁 Backfill all users
        </button>
      </div>
      <div id="backfill-status" class="hidden mt-3 text-sm"></div>
      <div class="mt-4 pt-4 border-t border-ink-700/60">
        <div class="flex items-center gap-2 flex-wrap">
          <button id="reconcile-run-btn" class="btn-ghost text-sm" ${cfg.appstore_api_configured ? '' : 'disabled'}>🛠 Run reconcile now</button>
          <button id="reconcile-refresh-btn" class="btn-ghost text-sm">↻ Refresh reconcile status</button>
        </div>
        <div id="reconcile-status" class="text-xs text-ink-400 mt-2"></div>
      </div>
    </section>

    <section class="grid grid-cols-1 xl:grid-cols-2 gap-6">
      <div class="card">
        <h3 class="font-semibold mb-3">Webhook endpoint</h3>
        <div class="text-sm text-ink-300 mb-2">Configure in App Store Connect → App Information → <span class="font-medium">App Store Server Notifications → Version 2</span>:</div>
        <pre class="bg-ink-800 rounded-lg p-3 text-xs font-mono overflow-x-auto"><code id="webhook-url">${location.origin}/webhook</code></pre>
        <div class="mt-3 text-xs text-ink-400">
          Apple will POST <code>{ "signedPayload": "&lt;JWS&gt;" }</code>. The JWS signature is verified via the x5c chain in the header. Set <code>APPSTORE_SKIP_VERIFICATION=true</code> to bypass (dev only).
        </div>
      </div>
      <div class="card">
        <h3 class="font-semibold mb-3">Send test notification (local simulator)</h3>
        <div class="flex flex-wrap gap-2 mb-3">
          ${[
            ['SUBSCRIBED','INITIAL_BUY'],
            ['DID_RENEW',null],
            ['DID_CHANGE_RENEWAL_STATUS','AUTO_RENEW_DISABLED'],
            ['DID_CHANGE_RENEWAL_STATUS','AUTO_RENEW_ENABLED'],
            ['DID_CHANGE_RENEWAL_PREF','UPGRADE'],
            ['DID_FAIL_TO_RENEW','GRACE_PERIOD'],
            ['EXPIRED','VOLUNTARY'],
            ['REFUND',null],
            ['SUBSCRIBED','RESUBSCRIBE'],
          ].map(([t, st]) => `
            <button class="btn-ghost text-xs" data-send='${JSON.stringify({ type: t, subtype: st })}'>${t}${st ? ':'+st : ''}</button>`).join('')}
        </div>
        <div class="text-xs text-ink-400">Will POST a decoded Apple notification to <code>/webhook/test</code> (bypasses JWS verification).</div>
      </div>
    </section>

    <section class="card mb-6">
      <h3 class="font-semibold mb-3">Send test notification (Apple API)</h3>
      <div class="text-xs text-ink-400 mb-3">
        Calls App Store Server API <code>/inApps/v1/notifications/test</code>. Apple then sends a real signed TEST notification to your configured webhook URL.
      </div>
      <div class="flex items-center gap-2 flex-wrap mb-3">
        <label class="text-xs text-ink-400">Environment</label>
        <select id="apple-test-env" class="text-sm">
          <option value="Sandbox">Sandbox</option>
          <option value="Production">Production</option>
        </select>
        <button id="apple-test-send-btn" class="btn-ghost text-sm" ${cfg.appstore_api_configured ? '' : 'disabled'}>🚀 Send Apple test</button>
        <button id="apple-test-poll-btn" class="btn-ghost text-sm" disabled>🔎 Check status</button>
      </div>
      <div id="apple-test-status" class="text-xs text-ink-400"></div>
    </section>

    <section class="card">
      <h3 class="font-semibold mb-3">Last 50 events (decoded)</h3>
      <div id="debug-list"></div>
    </section>
  `;

  const backfillBtn = $('#backfill-all-btn');
  if (backfillBtn) {
    backfillBtn.addEventListener('click', async () => {
      const status = $('#backfill-status');
      status.classList.remove('hidden');
      status.className = 'mt-3 text-sm text-ink-400';
      status.textContent = 'Loading subscriber list…';

      const list = await api('/subscribers?limit=200');
      const items = list.items || [];
      if (!items.length) { status.textContent = 'No subscribers to backfill.'; return; }

      backfillBtn.disabled = true;
      let fetched = 0, inserted = 0, skipped = 0, errors = 0;
      for (let i = 0; i < items.length; i++) {
        const u = items[i];
        status.textContent = `Backfilling ${i + 1}/${items.length} · ${u.app_user_id} · inserted ${inserted}, skipped ${skipped}, errors ${errors}`;
        try {
          const r = await apiPost(`/subscribers/${encodeURIComponent(u.app_user_id)}/sync`, {});
          if (r.error) errors++;
          else { fetched += r.fetched || 0; inserted += r.inserted || 0; skipped += r.skipped || 0; errors += r.errors || 0; }
        } catch (e) { errors++; }
      }
      status.className = 'mt-3 text-sm text-emerald-400';
      status.textContent = `✓ Done. Users ${items.length} · fetched ${fetched} · inserted ${inserted} · skipped ${skipped} · errors ${errors}.`;
      backfillBtn.disabled = false;
    });
  }

  const reconcileStatusEl = $('#reconcile-status');
  const reconcileRefreshBtn = $('#reconcile-refresh-btn');
  const reconcileRunBtn = $('#reconcile-run-btn');

  const loadReconcileStatus = async () => {
    try {
      const st = await api('/reconcile/status');
      if (st.running) {
        reconcileStatusEl.textContent = 'Reconcile is currently running…';
        return;
      }
      if (st.last_result) {
        const r = st.last_result;
        reconcileStatusEl.textContent =
          `Last run: users=${r.users}, checked=${r.checked}, drifted=${r.drifted}, repaired=${r.repaired_events}, refunds=${r.refund_events}, errors=${r.errors} (${new Date(r.finished_at).toLocaleString()})`;
      } else {
        reconcileStatusEl.textContent = 'No reconcile run yet.';
      }
    } catch (err) {
      reconcileStatusEl.textContent = `Failed to load reconcile status: ${err.message}`;
    }
  };
  if (reconcileRefreshBtn) reconcileRefreshBtn.addEventListener('click', loadReconcileStatus);
  if (reconcileRunBtn) {
    reconcileRunBtn.addEventListener('click', async () => {
      reconcileRunBtn.disabled = true;
      reconcileStatusEl.textContent = 'Running reconcile…';
      try {
        const out = await apiPost('/reconcile/run', { limit: 200, repair: true });
        if (out.error) throw new Error(out.message || out.error);
        reconcileStatusEl.textContent =
          `Done: checked=${out.checked}, drifted=${out.drifted}, repaired=${out.repaired_events}, refunds=${out.refund_events}, errors=${out.errors}.`;
      } catch (err) {
        reconcileStatusEl.textContent = `Reconcile failed: ${err.message}`;
      } finally {
        reconcileRunBtn.disabled = false;
      }
    });
  }
  loadReconcileStatus();

  const appleSendBtn = $('#apple-test-send-btn');
  const applePollBtn = $('#apple-test-poll-btn');
  const appleStatusEl = $('#apple-test-status');
  const appleEnvSel = $('#apple-test-env');
  if (appleEnvSel && cfg.environment) {
    appleEnvSel.value = /sandbox/i.test(cfg.environment) ? 'Sandbox' : 'Production';
  }
  let appleTestToken = null;

  if (appleSendBtn) {
    appleSendBtn.addEventListener('click', async () => {
      const env = $('#apple-test-env')?.value || 'Sandbox';
      appleSendBtn.disabled = true;
      appleStatusEl.textContent = `Sending Apple test notification (${env})…`;
      try {
        const r = await apiPost('/appstore/test-notification', { environment: env });
        if (r.error) throw new Error(r.message || r.error);
        appleTestToken = r.testNotificationToken || null;
        appleStatusEl.innerHTML = `✅ Sent. token: <span class="font-mono">${appleTestToken || 'n/a'}</span>. Click <b>Check status</b> after a few seconds.`;
        applePollBtn.disabled = !appleTestToken;
      } catch (err) {
        appleStatusEl.textContent = `❌ Failed: ${err.message}`;
      } finally {
        appleSendBtn.disabled = false;
      }
    });
  }

  if (applePollBtn) {
    applePollBtn.addEventListener('click', async () => {
      if (!appleTestToken) return;
      const env = $('#apple-test-env')?.value || 'Sandbox';
      applePollBtn.disabled = true;
      appleStatusEl.textContent = `Checking status (${env})…`;
      try {
        const r = await api(`/appstore/test-notification/${encodeURIComponent(appleTestToken)}?environment=${encodeURIComponent(env)}`);
        if (r.error) throw new Error(r.message || r.error);
        appleStatusEl.innerHTML = `<span class="text-emerald-300">Status response received.</span> <span class="font-mono">${JSON.stringify(r).slice(0, 280)}${JSON.stringify(r).length > 280 ? '…' : ''}</span>`;
      } catch (err) {
        appleStatusEl.textContent = `❌ Status failed: ${err.message}`;
      } finally {
        applePollBtn.disabled = false;
      }
    });
  }

  $$('[data-send]').forEach(btn => btn.addEventListener('click', async () => {
    const { type, subtype } = JSON.parse(btn.dataset.send);
    const now = Date.now();
    const originalTxId = 'otx_test_' + Math.random().toString(36).slice(2, 10);
    const appAccountToken = crypto.randomUUID();
    const product = { id: 'com.acme.pro.monthly', price: 9990, days: 30, type: 'Auto-Renewable Subscription', group: 'pro' };
    // Route to selected app (by bundleId); fall back to a fake bundle id for the
    // single-app default deployment so the test endpoint can resolve via fallback.
    const selectedApp = STATE.apps.find(a => a.id === STATE.appId);
    const targetBundleId = selectedApp?.bundle_id || 'com.acme.app';
    await fetch('/webhook/test' + (STATE.appId ? `?app_id=${encodeURIComponent(STATE.appId)}` : ''), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        notificationType: type, subtype,
        notificationUUID: crypto.randomUUID(), version: '2.0', signedDate: now,
        ...(STATE.appId ? { app_id: STATE.appId } : {}),
        data: { appAppleId: 1234567890, bundleId: targetBundleId, environment: 'Sandbox' },
        transactionInfo: {
          transactionId: 'tx_' + Math.random().toString(36).slice(2,14),
          originalTransactionId: originalTxId,
          webOrderLineItemId: String(Date.now()),
          bundleId: targetBundleId,
          productId: product.id,
          subscriptionGroupIdentifier: product.group,
          purchaseDate: now, originalPurchaseDate: now,
          expiresDate: now + product.days * 86400000,
          quantity: 1, type: product.type,
          appAccountToken, inAppOwnershipType: 'PURCHASED',
          signedDate: now, environment: 'Sandbox',
          storefront: 'USA', storefrontId: '143441',
          price: product.price, currency: 'USD',
        },
        renewalInfo: {
          originalTransactionId: originalTxId,
          autoRenewProductId: product.id, productId: product.id,
          autoRenewStatus: type === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED' ? 0 : 1,
          renewalDate: now + product.days * 86400000,
          environment: 'Sandbox', recentSubscriptionStartDate: now, signedDate: now,
        },
      }),
    });
  }));

  const data = await api('/events?limit=50');
  $('#debug-list').innerHTML = `
    <div class="space-y-2">
      ${data.items.map(e => `
        <details class="bg-ink-800 rounded-lg p-2">
          <summary class="cursor-pointer text-sm flex items-center gap-2">
            ${evBadge(e.type)}
            <span class="text-ink-400">${fmtRel(e.event_timestamp_ms)}</span>
            <span class="font-mono text-xs ml-auto">${truncate(e.app_user_id || '', 24)}</span>
          </summary>
          <button class="btn-ghost text-xs mt-2" onclick="showRawEvent(${e.id})">Show raw JSON</button>
          <pre id="raw-${e.id}" class="hidden bg-ink-900 rounded p-3 mt-2 text-xs font-mono overflow-x-auto"></pre>
        </details>`).join('') || emptyState('No events')}
    </div>
  `;
}

window.showRawEvent = async (id) => {
  const pre = $(`#raw-${id}`);
  if (!pre.classList.contains('hidden')) { pre.classList.add('hidden'); return; }
  const e = await api(`/events/${id}`);
  pre.textContent = JSON.stringify(e, null, 2);
  pre.classList.remove('hidden');
};

function renderAppleStatusCard(statusData) {
  if (!statusData) return '';
  if (statusData.error) {
    return `
      <div class="card mb-6 border border-rose-500/30">
        <div class="text-sm text-rose-300">Apple status check failed: ${statusData.message || statusData.error}</div>
      </div>
    `;
  }
  const drift = statusData.drift || {};
  const issues = drift.issues || [];
  return `
    <div class="card mb-6 ${drift.has_drift ? 'border border-amber-500/30' : 'border border-emerald-500/20'}">
      <div class="flex items-center justify-between mb-3">
        <h4 class="font-semibold">Apple Live Status</h4>
        <span class="text-xs ${drift.has_drift ? 'text-amber-300' : 'text-emerald-300'}">
          ${drift.has_drift ? 'drift detected' : 'in sync'}
        </span>
      </div>
      <div class="grid grid-cols-2 gap-3 text-sm mb-3">
        <div><span class="text-ink-400">Environment:</span> <span class="font-medium">${statusData.apple?.environment || statusData.environment || '—'}</span></div>
        <div><span class="text-ink-400">Anchor:</span> <span class="font-mono text-xs">${truncate(statusData.anchor || '', 18)}</span></div>
        <div><span class="text-ink-400">Local will renew:</span> ${boolBadge(statusData.local?.will_renew)}</div>
        <div><span class="text-ink-400">Apple will renew:</span> ${boolBadge(statusData.apple?.will_renew)}</div>
        <div><span class="text-ink-400">Local expires:</span> <span class="font-medium">${fmtDate(statusData.local?.expiration_ms)}</span></div>
        <div><span class="text-ink-400">Apple expires:</span> <span class="font-medium">${fmtDate(statusData.apple?.expiration_ms)}</span></div>
      </div>
      ${issues.length ? `
        <div class="space-y-2">
          ${issues.map(i => `<div class="text-xs rounded-md px-2 py-1 ${i.severity === 'danger' ? 'bg-rose-500/15 text-rose-200' : 'bg-amber-500/15 text-amber-100'}">${i.code}: ${i.message}</div>`).join('')}
        </div>
      ` : `<div class="text-xs text-emerald-300">No drift found between local DB and Apple live state.</div>`}
    </div>
  `;
}

// ============================================================
// SUBSCRIBER DETAIL
// ============================================================

async function openSubscriber(id) {
  const [data, cfg] = await Promise.all([
    api(`/subscribers/${encodeURIComponent(id)}`),
    api('/config').catch(() => ({})),
  ]);
  const s = data.subscriber;
  const canSync = !!cfg.appstore_api_configured;
  const appleStatus = canSync
    ? await api(`/subscribers/${encodeURIComponent(id)}/apple-status`).catch(err => ({ error: 'apple_status_failed', message: err.message }))
    : null;
  $('#sub-modal').classList.remove('hidden');
  $('#sub-modal-body').innerHTML = `
    <div class="flex items-start justify-between mb-6 gap-4">
      <div class="min-w-0">
        <div class="text-xs uppercase tracking-wide text-ink-400 mb-1">Subscriber</div>
        <div class="text-lg font-semibold font-mono break-all">${s.app_user_id}</div>
        <div class="mt-2 flex flex-wrap gap-2">
          ${statusBadge(s.status)}
          ${s.will_renew ? '<span class="badge badge-ok">will renew</span>' : '<span class="badge badge-warn">won\'t renew</span>'}
          ${s.ever_trial ? '<span class="badge badge-info">trial user</span>' : ''}
          ${s.trial_converted ? '<span class="badge badge-ok">converted from trial</span>' : ''}
        </div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        ${canSync
          ? `<button id="sub-sync-btn" class="btn-ghost text-sm" data-id="${encodeURIComponent(s.app_user_id)}" title="Pull this user's full purchase history from the App Store Server API">🔄 Sync from App Store</button>`
          : `<span class="text-xs text-ink-400" title="Set APPSTORE_ISSUER_ID, APPSTORE_KEY_ID, APPSTORE_PRIVATE_KEY[_PATH], APPSTORE_BUNDLE_ID to enable">App Store API not configured</span>`
        }
        ${canSync ? `<button id="sub-status-refresh-btn" class="btn-ghost text-sm" data-id="${encodeURIComponent(s.app_user_id)}" title="Refresh live Apple status">🛰 Refresh Apple status</button>` : ''}
        <button class="btn-ghost text-sm" onclick="document.getElementById('sub-modal').classList.add('hidden')">✕</button>
      </div>
    </div>
    <div id="sub-sync-status" class="hidden mb-4 text-sm"></div>

    ${canSync ? renderAppleStatusCard(appleStatus) : ''}

    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      ${kpiCard('LTV',          fmtMoney(s.ltv_usd))}
      ${kpiCard('Renewals',     fmtNum(s.renewals_count))}
      ${kpiCard('Refunded',     fmtMoney(s.refunded_usd))}
      ${kpiCard('Country',      s.country_code || '—')}
    </div>

    <div class="card mb-6">
      <div class="grid grid-cols-2 gap-3 text-sm">
        <div><span class="text-ink-400">Product:</span> <span class="font-medium">${s.current_product_id || '—'}</span></div>
        <div><span class="text-ink-400">Period:</span> <span class="font-medium">${s.period_type || '—'}</span></div>
        <div><span class="text-ink-400">Store:</span> <span class="font-medium">${s.store || '—'}</span></div>
        <div><span class="text-ink-400">Environment:</span> <span class="font-medium">${s.environment || '—'}</span></div>
        <div><span class="text-ink-400">Price:</span> <span class="font-medium">${fmtMoney(s.current_price_usd)}</span></div>
        <div><span class="text-ink-400">Expires:</span> <span class="font-medium">${fmtDate(s.expiration_ms)}</span></div>
        <div><span class="text-ink-400">First seen:</span> <span class="font-medium">${fmtDate(s.first_seen_ms)}</span></div>
        <div><span class="text-ink-400">Last event:</span> <span class="font-medium">${fmtRel(s.last_event_ms)}</span></div>
      </div>
    </div>

    <h4 class="font-semibold mb-3">Timeline · ${data.events.length} events</h4>
    <div class="timeline">
      ${data.events.map(e => {
        const sev = EVT_META[e.type]?.cls?.includes('ok') ? 'success'
                  : EVT_META[e.type]?.cls?.includes('warn') ? 'warning'
                  : EVT_META[e.type]?.cls?.includes('bad') ? 'danger' : 'info';
        return `
          <div class="timeline-item ${sev}">
            <span class="timeline-dot"></span>
            <div class="flex items-center gap-2 flex-wrap">
              ${evBadge(e.type)}
              <span class="text-sm">${e.product_id || ''} ${e.period_type ? `· ${e.period_type}` : ''}</span>
              ${e.price_usd ? `<span class="text-sm font-semibold">${fmtMoney(e.price_usd)}</span>` : ''}
              <span class="text-xs text-ink-400 ml-auto">${fmtDate(e.event_timestamp_ms)}</span>
            </div>
            ${(e.cancel_reason || e.expiration_reason) ? `<div class="text-xs text-ink-400 mt-1">Reason: ${e.cancel_reason || e.expiration_reason}</div>` : ''}
          </div>
        `;
      }).join('') || emptyState('No events for this subscriber')}
    </div>
  `;
}

document.addEventListener('click', async (e) => {
  const row = e.target.closest('tr[data-user]');
  if (row) openSubscriber(row.dataset.user);

  if (e.target.id === 'sub-modal') $('#sub-modal').classList.add('hidden');

  const syncBtn = e.target.closest('#sub-sync-btn');
  if (syncBtn) {
    const id = decodeURIComponent(syncBtn.dataset.id);
    const status = $('#sub-sync-status');
    syncBtn.disabled = true;
    syncBtn.textContent = '⏳ Syncing…';
    status.classList.remove('hidden');
    status.className = 'mb-4 text-sm text-ink-400';
    status.textContent = 'Pulling full transaction history from the App Store Server API…';
    try {
      const r = await apiPost(`/subscribers/${encodeURIComponent(id)}/sync`, {});
      if (r.error) throw new Error(r.message || r.error);
      status.className = 'mb-4 text-sm text-emerald-400';
      status.textContent = `✓ Synced — fetched ${r.fetched}, inserted ${r.inserted}, skipped ${r.skipped}${r.errors ? `, errors ${r.errors}` : ''}.`;
      // Refresh modal after a short delay
      setTimeout(() => openSubscriber(id), 600);
    } catch (err) {
      status.className = 'mb-4 text-sm text-rose-400';
      status.textContent = `✕ Sync failed: ${err.message}`;
      syncBtn.disabled = false;
      syncBtn.textContent = '🔄 Sync from App Store';
    }
  }

  const statusBtn = e.target.closest('#sub-status-refresh-btn');
  if (statusBtn) {
    const id = decodeURIComponent(statusBtn.dataset.id);
    statusBtn.disabled = true;
    const old = statusBtn.textContent;
    statusBtn.textContent = '⏳ Refreshing…';
    try {
      await openSubscriber(id);
    } finally {
      statusBtn.disabled = false;
      statusBtn.textContent = old || '🛰 Refresh Apple status';
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('#sub-modal').classList.add('hidden');
});

// ============================================================
// CHARTS
// ============================================================

function chartBaseOpts(extra = {}) {
  return {
    maintainAspectRatio: false,
    responsive: true,
    plugins: { legend: { display: true, position: 'top' } },
    scales: {
      x: { grid: { display: false }, ticks: { color: '#6b7194' } },
      y: { grid: { color: '#2a2f4455' }, ticks: { color: '#6b7194' },
           stacked: !!extra.stacked },
      ...(extra.stacked ? { x: { stacked: true, grid: { display: false }, ticks: { color: '#6b7194' } } } : {}),
    }
  };
}

function drawMrr(series) {
  charts.mrr = new Chart($('#mrrChart'), {
    type: 'line',
    data: {
      labels: series.map(s => s.date.slice(5)),
      datasets: [{
        label: 'MRR',
        data: series.map(s => s.mrr),
        borderColor: '#7c5cff',
        backgroundColor: 'rgba(124,92,255,.15)',
        fill: true, tension: .3, pointRadius: 0, borderWidth: 2,
      }]
    },
    options: {
      ...chartBaseOpts(),
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => fmtMoney(c.raw) } }
      },
      scales: { x: { grid: { display: false }, ticks: { color: '#6b7194' } },
                y: { grid: { color: '#2a2f4455' },
                     ticks: { color: '#6b7194', callback: (v) => '$' + v } } }
    }
  });
}

function drawRevenueDaily(daily) {
  charts.revenue = new Chart($('#revenueChart'), {
    type: 'bar',
    data: {
      labels: daily.map(d => d.date.slice(5)),
      datasets: [
        { label: 'Revenue', data: daily.map(d => d.revenue), backgroundColor: '#22c55e' },
        { label: 'Refunds', data: daily.map(d => -d.refunds), backgroundColor: '#ef4444' },
        {
          label: 'Net',
          type: 'line',
          data: daily.map(d => d.net_revenue || (d.revenue - d.refunds)),
          borderColor: '#7c5cff',
          backgroundColor: 'rgba(124,92,255,.15)',
          borderWidth: 2,
          tension: 0.25,
          pointRadius: 0,
          yAxisID: 'y',
        },
      ]
    },
    options: {
      ...chartBaseOpts(),
      plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: (c) => c.dataset.label + ': ' + fmtMoney(c.dataset.label === 'Refunds' ? Math.abs(c.raw) : c.raw) } } },
      scales: { x: { stacked: true, grid: { display: false }, ticks: { color: '#6b7194' } },
                y: { stacked: true, grid: { color: '#2a2f4455' }, ticks: { color: '#6b7194', callback: (v) => '$' + v } } }
    }
  });
}

function drawGrowthDaily(daily) {
  charts.growth = new Chart($('#growthChart'), {
    type: 'bar',
    data: {
      labels: daily.map(d => d.date.slice(5)),
      datasets: [
        { label: 'New subscribers', data: daily.map(d => d.new_subs), backgroundColor: '#7c5cff' },
        { label: 'Churned',         data: daily.map(d => -d.churned), backgroundColor: '#ef4444' },
      ]
    },
    options: {
      ...chartBaseOpts(),
      scales: { x: { stacked: true, grid: { display: false }, ticks: { color: '#6b7194' } },
                y: { stacked: true, grid: { color: '#2a2f4455' }, ticks: { color: '#6b7194' } } }
    }
  });
}

function drawActiveTrend(series) {
  charts.active = new Chart($('#activeChart'), {
    type: 'line',
    data: {
      labels: series.map(s => s.date.slice(5)),
      datasets: [{
        label: 'Active',
        data: series.map(s => s.active),
        borderColor: '#22c55e',
        backgroundColor: 'rgba(34,197,94,.15)',
        fill: true, tension: .3, pointRadius: 0, borderWidth: 2,
      }]
    },
    options: { ...chartBaseOpts(), plugins: { legend: { display: false } } }
  });
}

// ============================================================
// UI helpers
// ============================================================

function kpiCard(label, value, delta) {
  const deltaHtml = delta != null ? `<div class="kpi-delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}% vs prev</div>` : '';
  return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${deltaHtml}</div>`;
}

function statusBadge(status) {
  const map = {
    active:        'badge-ok',
    paused:        'badge-warn',
    expired:       'badge-neutral',
    billing_issue: 'badge-bad',
    cancelled:     'badge-warn',
  };
  return `<span class="badge ${map[status] || 'badge-neutral'}">${status}</span>`;
}

function flag(cc) {
  if (!cc || cc.length !== 2) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 0x1F1E6 - 65 + c.charCodeAt(0)));
}

function emptyState(msg) {
  return `<div class="py-12 text-center text-ink-400 text-sm">${msg}</div>`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function currentAppLabel() {
  if (!STATE.appId) return 'All apps';
  const a = STATE.apps.find(x => x.id === STATE.appId);
  return a ? `${a.name} · ${a.bundle_id}` : STATE.appId;
}

/** Sub-title showing the 30d net total — works for both single-app and multi-app modes. */
function dailyBreakdownSubtitle(daily, breakdown) {
  if (breakdown && breakdown.grand_total) {
    return `30d net total: <span class="text-ink-100 font-semibold">${fmtMoney(breakdown.grand_total.net)}</span> · ${breakdown.apps.length} apps`;
  }
  const net = daily.reduce((s, d) => s + (d.net_revenue ?? (d.revenue - d.refunds)), 0);
  return `30d net total: <span class="text-ink-100 font-semibold">${fmtMoney(net)}</span>`;
}

/**
 * Render the per-day numeric breakdown.
 * - Single-app (or 1 app configured): a clean two-column "Date — $X" list.
 * - Multi-app + "All apps" selected: a wide table with one column per app
 *   plus a Total column. Days without activity are omitted to keep the list short.
 */
function renderDailyBreakdown(daily, breakdown) {
  const formatDate = (iso) => {
    const d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', weekday: 'short',
    });
  };

  // Multi-app comparison view.
  if (breakdown && breakdown.apps && breakdown.apps.length > 1) {
    const { apps, rows, totals_by_app, grand_total } = breakdown;

    const visibleRows = rows.filter(r => Math.abs(r.total_net) > 0.005);
    if (!visibleRows.length) {
      return emptyState('No revenue activity in the last 30 days');
    }
    return `
      <div class="overflow-x-auto">
        <table class="table">
          <thead>
            <tr>
              <th class="whitespace-nowrap">Date</th>
              ${apps.map(a => `<th class="text-right whitespace-nowrap" title="${escapeHtml(a.bundle_id)}">${escapeHtml(a.name)}</th>`).join('')}
              <th class="text-right whitespace-nowrap">Total net</th>
            </tr>
          </thead>
          <tbody>
            ${visibleRows.slice().reverse().map(r => `
              <tr>
                <td class="whitespace-nowrap">${formatDate(r.date)} <span class="text-ink-400 text-xs">${r.date}</span></td>
                ${apps.map(a => {
                  const cell = r.by_app[a.id] || { net: 0 };
                  const cls = cell.net > 0 ? 'text-emerald-300'
                            : cell.net < 0 ? 'text-red-300' : 'text-ink-400';
                  return `<td class="text-right font-mono ${cls}">${fmtMoney(cell.net)}</td>`;
                }).join('')}
                <td class="text-right font-mono font-semibold">${fmtMoney(r.total_net)}</td>
              </tr>
            `).join('')}
          </tbody>
          <tfoot>
            <tr class="font-semibold">
              <td>30d total</td>
              ${apps.map(a => {
                const t = totals_by_app[a.id] || { net: 0 };
                return `<td class="text-right font-mono">${fmtMoney(t.net)}</td>`;
              }).join('')}
              <td class="text-right font-mono">${fmtMoney(grand_total.net)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    `;
  }

  // Single-app view (or only one app configured) — compact list.
  const visibleDays = daily.filter(d => {
    const net = d.net_revenue ?? (d.revenue - d.refunds);
    return Math.abs(net) > 0.005;
  });
  if (!visibleDays.length) {
    return emptyState('No revenue activity in the last 30 days');
  }
  return `
    <ul class="divide-y divide-ink-800">
      ${visibleDays.slice().reverse().map(d => {
        const net = d.net_revenue ?? (d.revenue - d.refunds);
        const refundChip = d.refunds > 0
          ? `<span class="text-xs text-red-300 ml-2">−${fmtMoney(d.refunds)} refunds</span>`
          : '';
        const netCls = net > 0 ? 'text-emerald-300'
                     : net < 0 ? 'text-red-300' : 'text-ink-400';
        return `
          <li class="flex items-center justify-between py-2">
            <div class="flex items-center gap-3">
              <span class="text-sm">${formatDate(d.date)}</span>
              <span class="text-xs text-ink-400">${d.date}</span>
              ${refundChip}
            </div>
            <div class="text-right">
              <div class="text-sm font-semibold font-mono ${netCls}">${fmtMoney(net)}</div>
              <div class="text-xs text-ink-400">${fmtMoney(d.revenue)} gross${d.renewals ? ` · ${d.renewals} renewals` : ''}${d.new_subs ? ` · ${d.new_subs} new` : ''}</div>
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function setTitle(title, sub) {
  $('#page-title').textContent = title;
  $('#page-sub').textContent = sub || '';
  $('#last-updated').textContent = 'updated ' + new Date().toLocaleTimeString();
}

function debounce(fn, wait = 200) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), wait); };
}

function renderNotifRow(n) {
  const sevCls = n.severity === 'success' ? 'badge-ok'
               : n.severity === 'warning' ? 'badge-warn'
               : n.severity === 'danger'  ? 'badge-bad' : 'badge-info';
  return `
    <div class="flex items-center gap-3 p-2 rounded-lg hover:bg-ink-800 cursor-pointer" ${n.app_user_id ? `onclick="location.hash='#subscribers?u=${encodeURIComponent(n.app_user_id)}'"` : ''}>
      <span class="badge ${sevCls}">${n.type}</span>
      <div class="flex-1 min-w-0">
        <div class="text-sm truncate">${n.title}</div>
        <div class="text-xs text-ink-400 truncate">${n.body || ''}</div>
      </div>
      <div class="text-xs text-ink-400 shrink-0">${fmtRel(n.created_at_ms)}</div>
    </div>`;
}

// ============================================================
// REALTIME (SSE)
// ============================================================

let _sse = null;
function startSse() {
  if (_sse) { try { _sse.close(); } catch (_) {} _sse = null; }
  const url = STATE.appId ? `/sse/stream?app_id=${encodeURIComponent(STATE.appId)}` : '/sse/stream';
  const es = new EventSource(url);
  _sse = es;
  es.addEventListener('hello', () => {
    $('#live-dot').classList.add('live-on');
    $('#live-text').textContent = 'live';
  });
  es.addEventListener('event', (e) => {
    const { notification: n } = JSON.parse(e.data);
    if (!n) return;
    showToast(n);

    // Live feed'e ekle (Overview aktifse)
    const feed = $('#live-feed');
    if (feed) {
      feed.insertAdjacentHTML('afterbegin', renderNotifRow(n));
      while (feed.children.length > 30) feed.lastElementChild.remove();
    }
  });
  es.onerror = () => {
    $('#live-dot').classList.remove('live-on');
    $('#live-text').textContent = 'reconnecting…';
  };
  return es;
}

function showToast(n) {
  const severityCls = {
    success: 'toast-success',
    warning: 'toast-warning',
    danger:  'toast-danger',
    info:    'toast-info',
  }[n.severity] || 'toast-info';

  const el = document.createElement('div');
  el.className = `toast ${severityCls}`;
  el.innerHTML = `
    <div class="flex items-start gap-3">
      <div class="flex-1 min-w-0">
        <div class="text-sm font-medium text-white">${n.title}</div>
        <div class="text-xs text-ink-300 truncate">${n.body || ''}</div>
        <div class="text-[10px] text-ink-400 mt-1">${n.type}</div>
      </div>
      ${n.amount_usd ? `<div class="text-sm font-semibold text-white shrink-0">${fmtMoney(n.amount_usd)}</div>` : ''}
    </div>`;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; }, 4500);
  setTimeout(() => el.remove(), 5000);
}

// ============================================================
// ROUTER
// ============================================================

const routes = {
  overview:    renderOverview,
  subscribers: renderSubscribers,
  events:      renderEvents,
  renewals:    renderRenewals,
  churn:       renderChurn,
  products:    renderProducts,
  geography:   renderGeography,
  debug:       renderDebug,
};

async function route() {
  destroyCharts();
  const hash = (location.hash || '#overview').slice(1);
  const [name] = hash.split('?');
  const fn = routes[name] || routes.overview;

  $$('.nav-link').forEach(a => a.classList.toggle('active', a.dataset.route === (name in routes ? name : 'overview')));
  $('#page').innerHTML = `<div class="text-ink-400">Loading…</div>`;
  try { await fn(); } catch (err) {
    $('#page').innerHTML = `<div class="card"><div class="text-red-400 font-medium mb-2">Failed to load</div><pre class="text-xs text-ink-400">${err.message}</pre></div>`;
  }
}

window.addEventListener('hashchange', route);
$('#refresh-btn').addEventListener('click', route);

// App selector — re-route + reconnect SSE on change.
$('#app-select')?.addEventListener('change', (e) => {
  STATE.appId = e.target.value || '';
  if (STATE.appId) localStorage.setItem('rp.app_id', STATE.appId);
  else localStorage.removeItem('rp.app_id');
  startSse();
  route();
});

// Initial bootstrap: load apps first, then route + open SSE.
(async () => {
  await loadApps();
  route();
  startSse();
})();

// auto refresh KPI cards every 60s on overview
setInterval(() => {
  if ((location.hash || '#overview').startsWith('#overview')) route();
}, 60000);
