import { Router } from 'express';
import { on } from '../services/bus.js';

export const sse = Router();

sse.get('/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const filterAppId = req.query.app_id || null;
  // Default to production-only so the dashboard never surfaces sandbox events
  // unless the user explicitly opted into them via ?env=sandbox or ?env=all.
  const rawEnv = (req.query.env || '').toString().toLowerCase().trim();
  const filterEnv =
    rawEnv === 'all' || rawEnv === '*' ? 'all'
    : rawEnv === 'sandbox' ? 'sandbox'
    : 'production';

  const write = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  write('hello', { at: Date.now(), app_id: filterAppId, env: filterEnv });

  const off = on('event', (payload) => {
    if (filterAppId && payload?.event?.app_id && payload.event.app_id !== filterAppId) {
      return;
    }
    if (filterEnv !== 'all') {
      const evEnv = (payload?.event?.environment || '').toString().toUpperCase();
      const wanted = filterEnv === 'sandbox' ? 'SANDBOX' : 'PRODUCTION';
      // Treat unknown/empty environment as PRODUCTION (legacy events).
      const normalized = evEnv === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION';
      if (normalized !== wanted) return;
    }
    write('event', payload);
  });

  const heartbeat = setInterval(() => {
    res.write(`: ping ${Date.now()}\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(heartbeat);
    off();
    res.end();
  });
});
