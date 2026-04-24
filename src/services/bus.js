import { EventEmitter } from 'node:events';

/** In-process pub/sub (SSE aboneleri için). */
export const bus = new EventEmitter();
bus.setMaxListeners(1000);

export function emit(channel, data) {
  bus.emit(channel, data);
}

export function on(channel, handler) {
  bus.on(channel, handler);
  return () => bus.off(channel, handler);
}
