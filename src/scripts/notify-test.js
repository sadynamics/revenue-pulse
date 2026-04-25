#!/usr/bin/env node
/**
 * Send a small "hello, I am alive" message to the configured Telegram chat.
 * Useful for verifying TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID without going
 * through the dashboard.
 */
import 'dotenv/config';
import '../db.js';
import { reloadApps } from '../services/apps.js';
import { sendBootPing } from '../services/notify/index.js';
import { configStatus } from '../services/notify/telegram.js';

reloadApps();

const cfg = configStatus();
if (!cfg.enabled) {
  console.error(
    '✖ Telegram is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID, then retry.'
  );
  console.error('  Detected:', cfg);
  process.exit(1);
}

console.log('→ sending Telegram ping...');
const result = await sendBootPing();
if (result.ok) {
  console.log('✓ ping sent. Check your Telegram chat.');
} else {
  console.error('✖ failed:', result);
  process.exit(2);
}
process.exit(0);
