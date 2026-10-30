import type { FastifyReply } from 'fastify';
import type { Config } from '../config.js';

export type Send = (event: string, data: unknown) => void;

/** Per-subject fan-out bus for the subject SSE stream. */
export class EventBus {
  private subs = new Map<string, Set<Send>>();

  subscribe(subjectId: string, send: Send): () => void {
    let set = this.subs.get(subjectId);
    if (!set) {
      set = new Set();
      this.subs.set(subjectId, set);
    }
    set.add(send);
    return () => {
      set.delete(send);
      if (set.size === 0) this.subs.delete(subjectId);
    };
  }

  emit(subjectId: string, event: string, data: unknown): void {
    const set = this.subs.get(subjectId);
    if (!set) return;
    for (const send of set) {
      try {
        send(event, data);
      } catch {
        set.delete(send);
      }
    }
  }

  listenerCount(subjectId: string): number {
    return this.subs.get(subjectId)?.size ?? 0;
  }
}

/** Prepare a reply for SSE streaming; returns a send() bound to the raw socket. */
export function sseReply(reply: FastifyReply, cfg: Config): Send {
  reply.hijack(); // we own the raw stream until the client disconnects
  const raw = reply.raw;
  raw.setHeader('content-type', 'text/event-stream');
  raw.setHeader('cache-control', 'no-cache');
  raw.setHeader('connection', 'keep-alive');
  raw.flushHeaders?.();
  raw.on('error', () => {}); // dead socket must not crash the process mid-stream
  const send: Send = (event, data) => {
    if (raw.destroyed || raw.writableEnded) return;
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => {
    raw.write(': ping\n\n');
  }, cfg.sseHeartbeatMs);
  heartbeat.unref();
  raw.on('close', () => clearInterval(heartbeat));
  return send;
}
