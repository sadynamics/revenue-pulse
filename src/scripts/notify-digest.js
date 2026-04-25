#!/usr/bin/env node
/**
 * Send the daily digest immediately (for the previous UTC day).
 * Equivalent to waiting for the scheduled cron tick.
 */
import 'dotenv/config';
import '../db.js';
import { reloadApps } from '../services/apps.js';
import { sendDailyDigestNow } from '../services/notify/index.js';
import { configStatus } from '../services/notify/telegram.js';

reloadApps();

const cfg = configStatus();
if (!cfg.enabled) {
  console.error(
    '✖ Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then retry.'
  );
  process.exit(1);
}

console.log('→ sending daily digest...');
await sendDailyDigestNow();
console.log('✓ digest sent. Check your Telegram chat.');
process.exit(0);
