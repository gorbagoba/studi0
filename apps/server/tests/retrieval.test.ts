import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness, type TestHarness } from './helpers';

// import counter for the transformers module — laziness assertions read this
const tfState = vi.hoisted(() => ({ imports: 0 }));
vi.mock('@huggingface/transformers', () => {
  tfState.imports++;
  return { pipeline: vi.fn(), env: {} };
});

vi.mock('../src/retrieval/embed.js', () => ({ embedTexts: vi.fn() }));
import { embedTexts } from '../src/retrieval/embed.js';
import { chunkSubject } from '../src/retrieval/chunk.js';
import { buildRetrievalIndex, ensureIndex } from '../src/retrieval/index.js';
import { hybridSearch, grepSearch } from '../src/retrieval/search.js';
import { pickGoldNodes } from '../src/http/routes/search.js';
import { insertSubject } from '../src/db/repos/subjects.js';

const embedMock = vi.mocked(embedTexts);
const f32 = (a: number[]) => new Float32Array(a);

let h: TestHarness | undefined;
const roots: string[] = [];

afterEach(async () => {
  if (h) {
    await h.close();
    h = undefined;
  }
  for (const r of roots.splice(0)) {
    await rm(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

/** fixture subject: material with headings + a pdf, graph with 2 nodes, a wiki page, a lesson */
async function makeSubjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'studi0-retr-'));
  roots.push(root);
  await mkdir(path.join(root, 'material'), { recursive: true });
  await mkdir(path.join(root, 'graphify-out', 'wiki'), { recursive: true });
  await mkdir(path.join(root, 'lessons'), { recursive: true });
  await writeFile(
    path.join(root, 'material', 'notes.md'),
    '# Intro\n\nalpha beta gamma\n\n## Deep dive\n\ndelta epsilon zeta\n',
    'utf8',
  );
  await writeFile(path.join(root, 'material', 'notes.pdf'), '%PDF-1.4 fixture', 'utf8');
  await writeFile(
    path.join(root, 'graphify-out', 'graph.json'),
    JSON.stringify({
      nodes: [
        {
          id: 'n1',
          label: 'Block cipher',
          description: 'splits plaintext into fixed blocks',
          source_file: 'notes.pdf',
        },
        { id: 'n2', label: 'Orphan node', description: 'source file missing from material', source_file: 'ghost.pdf' },
      ],
    }),
    'utf8',
  );
  await writeFile(path.join(root, 'graphify-out', 'wiki', 'Ciphers.md'), '# Ciphers\n\nwiki cipher prose\n', 'utf8');
  await writeFile(
    path.join(root, 'lessons', '0001.html'),
    '<html><head><title>Lesson One</title></head><body><h1>Lesson One</h1><p>lesson body about keys</p><h2>Part B</h2><p>second part text</p></body></html>',
    'utf8',
  );
  return root;
}

async function fixtureWithDenseChunks(): Promise<string> {
  const root = await makeSubjectRoot();
  await writeFile(
    path.join(root, 'material', 'dense.md'),
    [
      '# Dense test',
      '',
      'quantum flux capacitor',
      '',
      '## Ranking',
      '',
      'retrieval ranking fusion',
      '',
      '### Both',
      '',
      'retrieval ranking quantum',
      '',
      '## Filler',
      '',
      'misc filler prose',
      '',
    ].join('\n'),
    'utf8',
  );
  return root;
}

describe('chunker', () => {
  it('splits on headings with contextual headers and attributes graph nodes to their source file', async () => {
    const root = await makeSubjectRoot();
    const chunks = await chunkSubject(root);

    const intro = chunks.find((c) => c.relPath === 'material/notes.md' && c.text.includes('alpha beta'));
    expect(intro?.title).toBe('[Course file: material/notes.md — Intro]');
    const deep = chunks.find((c) => c.relPath === 'material/notes.md' && c.text.includes('delta'));
    expect(deep?.title).toContain('Deep dive');

    const node = chunks.find((c) => c.relPath === 'material/notes.pdf');
    expect(node?.title).toBe('[Course file: material/notes.pdf — Block cipher]');
    expect(node?.text).toContain('splits plaintext');
    const orphan = chunks.find((c) => c.relPath === 'graphify-out/graph.json');
    expect(orphan?.text).toContain('Orphan node');

    const wiki = chunks.find((c) => c.relPath === 'graphify-out/wiki/Ciphers.md');
    expect(wiki?.text).toContain('wiki cipher prose');

    const lesson = chunks.find((c) => c.relPath === 'lessons/0001.html' && c.text.includes('lesson body'));
    expect(lesson?.title).toContain('Lesson One');
    expect(lesson?.text).not.toContain('<p>');
    const partB = chunks.find((c) => c.relPath === 'lessons/0001.html' && c.text.includes('second part'));
    expect(partB?.title).toContain('Part B');
  });
});

describe('index + hybrid search', () => {
  it('FTS5 finds a chunk by exact terms and by alternate (reordered) wording — bm25 both', async () => {
    h = await makeHarness();
    const root = await makeSubjectRoot();
    embedMock.mockRejectedValue(new Error('embedder down (test)'));
    await buildRetrievalIndex(h.ctx.db, 's1', root, { log: () => {} });

    const exact = await hybridSearch(h.ctx.db, 's1', 'alpha beta');
    expect(exact[0]?.relPath).toBe('material/notes.md');
    expect(exact[0]?.channels).toContain('bm25');
    expect(exact[0]?.channels).not.toContain('dense');

    const alt = await hybridSearch(h.ctx.db, 's1', 'zeta reordered delta epsilon');
    expect(alt.some((x) => x.snippet.includes('delta epsilon'))).toBe(true);
  });

  it('RRF fusion surfaces the dense-only chunk, the bm25 chunk, and ranks the dual-channel chunk first', async () => {
    h = await makeHarness();
    const root = await fixtureWithDenseChunks();
    embedMock.mockImplementation(async (texts: string[]) =>
      texts.map((t) => {
        if (t.includes('zzprobe')) return f32([0.8, 0.6, 0]); // the query
        if (t.includes('quantum flux capacitor')) return f32([1, 0, 0]); // A: dense-only
        if (t.includes('retrieval ranking quantum')) return f32([0.8, 0.6, 0]); // D: both channels
        return f32([0, 1, 0]); // B + filler
      }),
    );
    await buildRetrievalIndex(h.ctx.db, 's2', root, { log: () => {} });

    // 'quantum' is absent from the query → bm25 cannot find A; dense must carry it in
    const hits = await hybridSearch(h.ctx.db, 's2', 'retrieval ranking zzqq zzprobe', { k: 5 });
    expect(hits[0]?.snippet).toContain('retrieval ranking quantum');
    expect(hits[0]?.channels).toEqual(['bm25', 'dense']);
    const denseOnly = hits.find((x) => x.snippet.includes('quantum flux capacitor'));
    expect(denseOnly?.channels).toEqual(['dense']);
  });

  it('ensureIndex skips a fresh index and rebuilds when a source file is touched', async () => {
    h = await makeHarness();
    const root = await makeSubjectRoot();
    embedMock.mockRejectedValue(new Error('embedder down (test)'));
    const subject = { id: 's3', path: root };
    await ensureIndex(h.ctx.db, subject, { log: () => {} });
    const builtAt = () =>
      (
        h!.ctx.db.prepare('SELECT built_at FROM r_index_meta WHERE subject_id = ?').get('s3') as {
          built_at: string;
        }
      ).built_at;
    const first = builtAt();
    await new Promise((r) => setTimeout(r, 15));
    await ensureIndex(h.ctx.db, subject, { log: () => {} });
    expect(builtAt()).toBe(first); // fresh — no rebuild

    const future = new Date(Date.now() + 5000);
    await utimes(path.join(root, 'material', 'notes.md'), future, future);
    await ensureIndex(h.ctx.db, subject, { log: () => {} });
    expect(builtAt()).not.toBe(first); // stale — rebuilt
  });

  it('falls back to grep with no index and stays bm25-only when the embedder throws', async () => {
    h = await makeHarness();
    const root = await makeSubjectRoot();
    embedMock.mockRejectedValue(new Error('embedder down (test)'));

    const grep = await hybridSearch(h.ctx.db, 'no-index-subject', 'alpha beta gamma', { subjectPath: root });
    expect(grep.length).toBeGreaterThan(0);
    expect(grep[0]?.channels).toEqual(['grep']);
    expect(grep[0]?.relPath).toBe('material/notes.md');

    await expect(hybridSearch(h.ctx.db, 'no-index-subject', 'alpha')).resolves.toEqual([]);

    await buildRetrievalIndex(h.ctx.db, 's4', root, { log: () => {} });
    const bm25Only = await hybridSearch(h.ctx.db, 's4', 'alpha beta');
    expect(bm25Only[0]?.relPath).toBe('material/notes.md');
    expect(bm25Only[0]?.channels).toEqual(['bm25']);

    const direct = await grepSearch(root, 'wiki cipher');
    expect(direct[0]?.relPath).toBe('graphify-out/wiki/Ciphers.md');
  });
});

describe('routes', () => {
  it('GET /api/subjects/:id/search returns hybrid hits and validates q', async () => {
    h = await makeHarness();
    const root = await makeSubjectRoot();
    embedMock.mockRejectedValue(new Error('embedder down (test)'));
    insertSubject(h.ctx.db, { id: 'route-subj', name: 'R1', path: root, created_at: new Date().toISOString() });

    const res = await h.app.inject({ method: 'GET', url: '/api/subjects/route-subj/search?q=alpha%20beta' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits.length).toBeGreaterThan(0);
    expect(body.hits[0].relPath).toBe('material/notes.md');

    const bad = await h.app.inject({ method: 'GET', url: '/api/subjects/route-subj/search' });
    expect(bad.statusCode).toBe(400);
  });

  it('pickGoldNodes keeps only nodes whose source file exists under material/', () => {
    const map = new Map([['notes.pdf', 'material/notes.pdf']]);
    const nodes = pickGoldNodes(
      { nodes: [{ label: 'A', source_file: 'notes.pdf' }, { label: 'B', source_file: 'ghost.pdf' }, { label: 42 }] },
      map,
      10,
    );
    expect(nodes).toEqual([{ label: 'A', goldRelPath: 'material/notes.pdf' }]);
  });
});

describe('embedder laziness', () => {
  it('retrieval work never imports @huggingface/transformers when embed.ts is mocked', async () => {
    h = await makeHarness();
    const root = await makeSubjectRoot();
    embedMock.mockRejectedValue(new Error('embedder down (test)'));
    await buildRetrievalIndex(h.ctx.db, 'lazy', root, { log: () => {} });
    await hybridSearch(h.ctx.db, 'lazy', 'alpha');
    expect(tfState.imports).toBe(0);
  });

  it('real embed.ts imports the transformers module only inside embedTexts (then memoizes failure)', async () => {
    vi.resetModules();
    vi.doUnmock('../src/retrieval/embed.js');
    const real = await import('../src/retrieval/embed.js');
    expect(tfState.imports).toBe(0); // module loaded — ONNX not yet
    await expect(real.embedTexts(['hi'])).rejects.toThrow();
    expect(tfState.imports).toBe(1); // lazy dynamic import fired
    await expect(real.embedTexts(['hi'])).rejects.toThrow();
    expect(tfState.imports).toBe(1); // memoized failure — no re-import
  });
});
