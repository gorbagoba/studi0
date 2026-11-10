import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGraphifyExtract } from '../src/graph/extract.js';
import { makeConfig } from '../src/config.js';
import { isAlive } from '../src/util/proc.js';

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

async function subjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-extract-'));
  made.push(dir);
  return dir;
}

/**
 * Fake graphify step: GRAPHIFY_BIN is node, and `node <name> <args…>` runs this
 * extension-less file from the subject cwd — no shell, exact argv observable.
 * getBuiltinModule keeps it working in both CJS and ESM resolution.
 */
async function fakeGraphify(dir: string, name: string, body: string): Promise<void> {
  await writeFile(path.join(dir, name), `const fs = process.getBuiltinModule('node:fs');\n${body}\n`);
}

const record = (file: string) =>
  `fs.writeFileSync('${file}', JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: process.env }));`;

function cfgFor(dir: string) {
  return {
    ...makeConfig(),
    graphifyBin: process.execPath,
    graphTokenBudget: 3000,
    graphBackend: 'openai',
    graphBaseUrl: 'http://gw.local/v1',
    graphApiKey: 'gw-key',
    graphModel: 'm1',
    graphifyVenv: path.join(dir, 'venv'),
  };
}

describe('runGraphifyExtract (server-owned extraction)', () => {
  it('runs extract + cluster-only in the subject dir with graphEnv and the configured budget', async () => {
    const dir = await subjectDir();
    await fakeGraphify(
      dir,
      'extract',
      `${record('extract-step.json')}
fs.mkdirSync('graphify-out', { recursive: true });
fs.writeFileSync('graphify-out/graph.json', '{"nodes":[],"links":[]}');
console.log('chunk 3/7');
console.log('wrote graphify-out/graph.json: 24 nodes, 24 edges');`,
    );
    await fakeGraphify(dir, 'cluster-only', record('cluster-step.json'));
    const logs: string[] = [];
    const progress: [number, number][] = [];

    const result = await runGraphifyExtract({
      cfg: cfgFor(dir),
      subjectPath: dir,
      log: (m) => logs.push(m),
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(result).toEqual({ ok: true });
    const extractStep = JSON.parse(await readFile(path.join(dir, 'extract-step.json'), 'utf8'));
    expect(extractStep.argv).toEqual(['material', '--out', '.', '--token-budget', '3000']);
    expect(path.resolve(extractStep.cwd)).toBe(path.resolve(dir));
    expect(extractStep.env).toMatchObject({
      GRAPHIFY_BACKEND: 'openai',
      OPENAI_BASE_URL: 'http://gw.local/v1',
      OPENAI_API_KEY: 'gw-key',
      GRAPHIFY_OPENAI_MODEL: 'm1',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
    });
    const clusterStep = JSON.parse(await readFile(path.join(dir, 'cluster-step.json'), 'utf8'));
    expect(clusterStep.argv).toEqual(['.']);
    expect(path.resolve(clusterStep.cwd)).toBe(path.resolve(dir));

    expect(logs.some((l) => l.includes('graphify: chunk 3/7'))).toBe(true);
    expect(logs).toContain('progress 3/7');
    expect(progress).toEqual([[3, 7]]);
    expect(logs).toContain('graph.json: 24 nodes, 24 edges');
  }, 30_000);

  it('non-zero exit is a failure, with the step named — and is not retried', async () => {
    const dir = await subjectDir();
    await fakeGraphify(
      dir,
      'extract',
      `fs.appendFileSync('attempts.log', 'x');\nconsole.log('401 unauthorized — check the backend key');\nprocess.exit(3);`,
    );
    const logs: string[] = [];
    const result = await runGraphifyExtract({
      cfg: cfgFor(dir),
      subjectPath: dir,
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ ok: false, error: 'graphify extraction exited with code 3' });
    // a bad backend/key is not an incomplete pass: exactly one attempt
    expect(await readFile(path.join(dir, 'attempts.log'), 'utf8')).toBe('x');
    expect(logs).not.toContain('retrying extraction (cache resumes)');
  }, 30_000);

  it('retries extraction once when graphify reports an incomplete/hollow pass', async () => {
    const dir = await subjectDir();
    await fakeGraphify(
      dir,
      'extract',
      `const n = Number(fs.existsSync('attempts.txt') ? fs.readFileSync('attempts.txt', 'utf8') : '0') + 1;
fs.writeFileSync('attempts.txt', String(n));
fs.appendFileSync('extract.log', 'attempt ' + n + '\\n');
if (n === 1) {
  console.log('semantic extraction is incomplete: 2 dispatched file(s) produced no nodes and 2 came back truncated or hollow.');
  console.log('Refusing to overwrite — saved semantic node(s) are missing');
  process.exit(1);
}
fs.mkdirSync('graphify-out', { recursive: true });
fs.writeFileSync('graphify-out/graph.json', '{}');
console.log('wrote graphify-out/graph.json: 24 nodes, 24 edges');`,
    );
    await fakeGraphify(dir, 'cluster-only', 'process.exit(0);');
    const logs: string[] = [];
    const result = await runGraphifyExtract({
      cfg: cfgFor(dir),
      subjectPath: dir,
      log: (m) => logs.push(m),
    });
    expect(result).toEqual({ ok: true });
    const attempts = (await readFile(path.join(dir, 'extract.log'), 'utf8')).trim().split('\n');
    expect(attempts).toEqual(['attempt 1', 'attempt 2']);
    expect(logs).toContain('retrying extraction (cache resumes)');
    expect(logs).toContain('graph.json: 24 nodes, 24 edges');
  }, 30_000);

  it('shares the timeout budget across the retry', async () => {
    const dir = await subjectDir();
    await fakeGraphify(
      dir,
      'extract',
      `const n = Number(fs.existsSync('attempts.txt') ? fs.readFileSync('attempts.txt', 'utf8') : '0') + 1;
fs.writeFileSync('attempts.txt', String(n));
if (n === 1) {
  console.log('semantic extraction is incomplete: 2 dispatched file(s) produced no nodes');
  process.exit(1);
}
setTimeout(() => {}, 30000);`,
    );
    const logs: string[] = [];
    const t0 = Date.now();
    const result = await runGraphifyExtract({
      cfg: cfgFor(dir),
      subjectPath: dir,
      log: (m) => logs.push(m),
      timeoutMs: 1500,
    });
    const elapsed = Date.now() - t0;
    expect(result).toMatchObject({ ok: false });
    expect((result as { ok: false; error: string }).error).toContain('timed out after');
    expect(elapsed).toBeLessThan(5000);
    expect((await readFile(path.join(dir, 'attempts.txt'), 'utf8')).trim()).toBe('2');
    expect(logs).toContain('retrying extraction (cache resumes)');
  }, 30_000);

  it('times out, kill-trees the child and returns not-ok', async () => {
    const dir = await subjectDir();
    await fakeGraphify(dir, 'extract', `fs.writeFileSync('pid.txt', String(process.pid)); setTimeout(() => {}, 30000);`);
    const result = await runGraphifyExtract({
      cfg: cfgFor(dir),
      subjectPath: dir,
      log: () => undefined,
      timeoutMs: 300,
    });
    expect(result).toEqual({ ok: false, error: 'graphify extraction timed out after 300ms' });
    const pid = Number((await readFile(path.join(dir, 'pid.txt'), 'utf8')).trim());
    let dead = !isAlive(pid);
    for (let i = 0; i < 40 && !dead; i++) {
      await new Promise((r) => setTimeout(r, 100));
      dead = !isAlive(pid);
    }
    expect(dead).toBe(true);
  }, 30_000);

  it('exit 0 without graph.json is not success', async () => {
    const dir = await subjectDir();
    await fakeGraphify(dir, 'extract', 'process.exit(0);');
    await fakeGraphify(dir, 'cluster-only', 'process.exit(0);');
    const result = await runGraphifyExtract({ cfg: cfgFor(dir), subjectPath: dir, log: () => undefined });
    expect(result).toEqual({
      ok: false,
      error: 'graphify extraction produced no graphify-out/graph.json',
    });
  }, 30_000);
});
