import { buildApp } from './http/app.js';
import { ensureLayout, syncTeacherAgent } from './fs/layout.js';
import { listSubjects } from './db/repos/subjects.js';

const { app, ctx } = buildApp();

// resync the canonical teacher agent file into every registered subject
for (const subject of listSubjects(ctx.db)) {
  try {
    await ensureLayout(subject.path);
    await syncTeacherAgent(subject.path);
  } catch {
    // subject folder may be temporarily unavailable (unplugged drive) — keep booting
  }
}

// managed opencode server; chat/practice return 503 until it is healthy
await ctx.oc.boot().catch(() => undefined);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app
      .close()
      .then(() => ctx.oc.stop())
      .then(() => ctx.db.close())
      .then(() => process.exit(0));
  });
}

await app.listen({ port: ctx.cfg.port, host: ctx.cfg.host });
console.log(`studi0 server listening on http://${ctx.cfg.host}:${ctx.cfg.port}`);
