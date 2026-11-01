import { describe, expect, it, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { makeHarness } from './helpers';
import type { TestHarness } from './helpers';

// tiny target so small fixture pdfs actually split (config reads this at buildApp time;
// a blank pypdf page is only ~150 bytes, so 30 pages ≈ 5 KB → ~5 parts at 1 KB target)
process.env.STUDI0_SPLIT_TARGET_BYTES = '1024';

let h: TestHarness | undefined;

afterEach(async () => {
  if (h) await h.close();
  h = undefined;
});

const pythonOk = await new Promise<boolean>((resolve) => {
  const c = spawn('python', ['-c', 'import pypdf'], { windowsHide: true });
  c.on('error', () => resolve(false));
  c.on('close', (code) => resolve(code === 0));
});

function py(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const c = spawn('python', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    c.stdout?.on('data', (d: Buffer) => stdout.push(d));
    c.stderr?.on('data', (d: Buffer) => stderr.push(d));
    c.on('error', reject);
    c.on('close', (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }),
    );
  });
}

async function makePdf(abs: string, pages: number): Promise<void> {
  const res = await py([
    '-c',
    'import sys\nfrom pypdf import PdfWriter\nw = PdfWriter()\nfor _ in range(int(sys.argv[2])): w.add_blank_page(width=612, height=792)\nw.write(sys.argv[1])',
    abs,
    String(pages),
  ]);
  if (res.code !== 0) throw new Error(`fixture pdf failed: ${res.stderr}`);
}

async function pageCount(absPaths: string[]): Promise<number[]> {
  const res = await py([
    '-c',
    'import sys, json\nfrom pypdf import PdfReader\nprint(json.dumps([len(PdfReader(p).pages) for p in sys.argv[1:]]))',
    ...absPaths,
  ]);
  if (res.code !== 0) throw new Error(`page count failed: ${res.stderr}`);
  return JSON.parse(res.stdout.trim().split('\n').pop() as string) as number[];
}

async function createSubject(name: string): Promise<{ id: string; root: string }> {
  const res = await h!.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  const body = res.json() as { id: string; path: string };
  return { id: body.id, root: body.path };
}

describe.skipIf(!pythonOk)('pdf split (T-P3)', () => {
  it('splits a large pdf into parts next to the original, syncs file rows, original untouched', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Split');
    const rel = 'material/semester.pdf';
    const abs = path.join(root, rel);
    await makePdf(abs, 30);
    const before = statSync(abs);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/split-pdf`,
      payload: { file: rel },
    });
    expect(res.statusCode).toBe(200);
    const { parts } = res.json() as { parts: string[] };
    expect(parts.length).toBeGreaterThanOrEqual(2);
    expect(parts.every((p) => /^material\/semester_p\d+\.pdf$/.test(p))).toBe(true);
    expect(parts).not.toContain(rel);
    // parts are real pdfs whose page counts sum to the original's
    const counts = await pageCount(parts.map((p) => path.join(root, p)));
    expect(counts.every((n) => n > 0)).toBe(true);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(30);
    // original untouched
    const after = statSync(abs);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    // file rows synced like uploads
    const rows = h.ctx.db.prepare('SELECT rel_path FROM files WHERE subject_id = ?').all(id) as {
      rel_path: string;
    }[];
    for (const p of parts) expect(rows.map((r) => r.rel_path)).toContain(p);
    const tree = (
      await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/tree?dir=material` })
    ).json() as { entries: { path: string; bytes: number }[] };
    for (const p of parts) {
      const e = tree.entries.find((x) => x.path === p);
      expect(e?.bytes).toBeGreaterThan(0);
    }
  }, 60_000);

  it('returns the original unsplit when it is at or below the target size', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Small');
    const rel = 'material/tiny.pdf';
    await makePdf(path.join(root, rel), 2);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/split-pdf`,
      payload: { file: rel },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ parts: [rel] });
  }, 60_000);

  it('hard-gates traversal, non-material paths, missing files and non-pdfs', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('Guard');
    await makePdf(path.join(root, 'lessons', 'inside.pdf'), 1);
    await makePdf(path.join(root, 'material', 'notes.pdf'), 1);
    await (await import('node:fs/promises')).writeFile(path.join(root, 'material', 'notes.md'), 'x');
    const post = (file: string) =>
      h!.app.inject({ method: 'POST', url: `/api/subjects/${id}/split-pdf`, payload: { file } });
    const traversal = await post('../../escape.pdf');
    expect(traversal.statusCode).toBe(400);
    expect(traversal.json().error.code).toBe('PATH_TRAVERSAL');
    const outsideMaterial = await post('lessons/inside.pdf');
    expect(outsideMaterial.statusCode).toBe(400);
    expect(outsideMaterial.json().error.code).toBe('PATH_TRAVERSAL');
    const missing = await post('material/nope.pdf');
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('FILE_NOT_FOUND');
    const notPdf = await post('material/notes.md');
    expect(notPdf.statusCode).toBe(415);
    expect(notPdf.json().error.code).toBe('UNSUPPORTED_FILE_TYPE');
  }, 60_000);
});
