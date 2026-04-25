/**
 * Minimal Telegram Bot API client.
 *
 *  - Single chat, single bot.
 *  - HTML parse mode (works with the helpers in ./format.js).
 *  - In-memory FIFO queue with a small inter-message delay so we don't trip
 *    Telegram's "1 msg/sec per chat" guard during bursts (e.g. when reconcile
 *    finds a batch of missed renewals and we briefly emit 50 events back to
 *    back).
 *  - Configurable test-mode endpoint via TELEGRAM_API_BASE for local smoke
 *    tests, so the real network isn't hit during CI.
 */

const API_BASE =
  (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

function readToken() {
  return (process.env.TELEGRAM_BOT_TOKEN || '').trim();
}
function readChatId() {
  return (process.env.TELEGRAM_CHAT_ID || '').trim();
}

export function isConfigured() {
  return !!(readToken() && readChatId());
}

/**
 * Default config snapshot for diagnostics. We only return whether values are
 * present, never the values themselves.
 */
export function configStatus() {
  return {
    enabled: isConfigured(),
    has_token: !!readToken(),
    has_chat_id: !!readChatId(),
  };
}

const QUEUE_GAP_MS = Math.max(50, Number(process.env.TELEGRAM_QUEUE_GAP_MS || 350));
const queue = [];
let draining = false;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function postOnce(text, opts = {}) {
  const token = readToken();
  const chatId = readChatId();
  if (!token || !chatId) {
    throw new Error('telegram_not_configured');
  }
  const url = `${API_BASE}/bot${token}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: opts.parse_mode || 'HTML',
    disable_web_page_preview: opts.disable_web_page_preview ?? true,
    disable_notification: opts.silent ?? false,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) {
    const desc = json.description || `${res.status} ${res.statusText}`;
    const retryAfter = Number(json?.parameters?.retry_after);
    const err = new Error(`telegram_send_failed: ${desc}`);
    err.retryAfter = Number.isFinite(retryAfter) ? retryAfter : 0;
    err.statusCode = res.status;
    throw err;
  }
  return json.result;
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      try {
        const result = await postOnce(job.text, job.opts);
        job.resolve(result);
      } catch (err) {
        if (err.retryAfter && err.retryAfter > 0) {
          // Telegram is rate-limiting us — back off and re-queue at the head.
          queue.unshift(job);
          await sleep((err.retryAfter + 1) * 1000);
          continue;
        }
        // Don't propagate to caller of enqueue() — it's fire-and-forget — but
        // log so misconfigurations are visible.
        console.warn(`[notify][telegram] send failed: ${err.message}`);
        job.reject(err);
      }
      await sleep(QUEUE_GAP_MS);
    }
  } finally {
    draining = false;
  }
}

/**
 * Enqueue a message. Resolves with the Telegram API result (or rejects with an
 * Error on permanent failure). Callers usually fire-and-forget.
 */
export function sendMessage(text, opts = {}) {
  if (!isConfigured()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    queue.push({ text, opts, resolve, reject });
    void drain();
  });
}

/** Drain the queue immediately (mostly for tests). */
export async function flush() {
  await drain();
}

export function queueSize() {
  return queue.length;
}
