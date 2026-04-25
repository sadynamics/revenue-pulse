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

  const write = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  write('hello', { at: Date.now(), app_id: filterAppId });

  const off = on('event', (payload) => {
    if (filterAppId && payload?.event?.app_id && payload.event.app_id !== filterAppId) {
      return;
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
