import { describe, expect, it, afterEach } from 'vitest';
import { mkdir, writeFile, mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness } from './helpers';
import { makeConfig } from '../src/config.js';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

async function existingCourseDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-course-'));
  await mkdir(path.join(dir, 'material', 'week1'), { recursive: true });
  await writeFile(path.join(dir, 'material', 'week1', 'intro.pdf'), 'PDFDATA');
  await writeFile(path.join(dir, 'syllabus.md'), '# week 1\n');
  return dir;
}

describe('subjects CRUD (T03)', () => {
  it('registers an existing folder in place — nothing copied or moved', async () => {
    h = await makeHarness();
    const courseDir = await existingCourseDir();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/subjects',
      payload: { name: 'CS2040C', path: courseDir },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.name).toBe('CS2040C');
    expect(body.path).toBe(path.resolve(courseDir));
    expect(body.graphStatus).toBe('none');
    // original files untouched, layout ensured in place
    await expect(stat(path.join(courseDir, 'material', 'week1', 'intro.pdf'))).resolves.toBeTruthy();
    await expect(stat(path.join(courseDir, 'graphify-out'))).resolves.toBeTruthy();
    // teacher agent synced byte-identical
    const canonical = await readFile(
      path.resolve(import.meta.dirname, '../src/../agents/studi0-teacher.md'),
      'utf8',
    );
    const synced = await readFile(
      path.join(courseDir, '.opencode', 'agents', 'studi0-teacher.md'),
      'utf8',
    );
    expect(synced).toBe(canonical);
    // pipeline agent synced alongside the teacher agent, with the concurrency
    // placeholder interpolated (the canonical file ships with {{CHUNK_CONCURRENCY}})
    const pipelineSynced = await readFile(
      path.join(courseDir, '.opencode', 'agents', 'studi0-pipeline.md'),
      'utf8',
    );
    const pipelineCanonical = (
      await readFile(path.resolve(import.meta.dirname, '../src/../agents/studi0-pipeline.md'), 'utf8')
    ).replaceAll('{{CHUNK_CONCURRENCY}}', String(makeConfig().maxChunkConcurrency));
    expect(pipelineSynced).toBe(pipelineCanonical);
    await rm(courseDir, { recursive: true, force: true });
  });

  it('creates a fresh subject under the data dir when no path given', async () => {
    h = await makeHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/subjects',
      payload: { name: 'Fresh' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().path.startsWith(path.resolve(h.dataDir, 'subjects'))).toBe(true);
  });

  it('rejects missing paths and duplicate names', async () => {
    h = await makeHarness();
    const missing = await h.app.inject({
      method: 'POST',
      url: '/api/subjects',
      payload: { name: 'X', path: path.join(tmpdir(), 'definitely-missing-9137') },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.code).toBe('PATH_NOT_FOUND');

    await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name: 'CS' } });
    const dup = await h.app.inject({
      method: 'POST',
      url: '/api/subjects',
      payload: { name: 'CS' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('NAME_TAKEN');
  });

  it('renames the display name only, deletes only the index row', async () => {
    h = await makeHarness();
    const courseDir = await existingCourseDir();
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/subjects',
        payload: { name: 'Before', path: courseDir },
      })
    ).json();
    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/subjects/${created.id}`,
      payload: { name: 'After' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('After');

    const del = await h.app.inject({ method: 'DELETE', url: `/api/subjects/${created.id}` });
    expect(del.statusCode).toBe(204);
    const folderStillThere = await stat(path.join(courseDir, 'material'));
    expect(folderStillThere.isDirectory()).toBe(true);
    await rm(courseDir, { recursive: true, force: true });
  });

  it('marks stale when material changed after the last build (AC5/AC6 fast path)', async () => {
    h = await makeHarness();
    const courseDir = await existingCourseDir();
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/subjects',
        payload: { name: 'StaleCheck', path: courseDir },
      })
    ).json();
    // pretend a build just completed (after the current files existed)
    h.ctx.db
      .prepare('UPDATE subjects SET last_built_at = ? WHERE id = ?')
      .run(new Date().toISOString(), created.id);
    const before = (await h.app.inject({ method: 'GET', url: `/api/subjects/${created.id}` })).json();
    expect(before.stale).toBe(false);
    // new material arrives
    await writeFile(path.join(courseDir, 'material', 'week2.pdf'), 'NEW');
    const after = (await h.app.inject({ method: 'GET', url: `/api/subjects/${created.id}` })).json();
    expect(after.stale).toBe(true);
    expect(after.graphStatus).toBe('none'); // no graph.json yet — staleness shows on the flag
    await rm(courseDir, { recursive: true, force: true });
  });

  it('tree: allowlisted roots only, traversal rejected', async () => {
    h = await makeHarness();
    const courseDir = await existingCourseDir();
    const created = (
      await h.app.inject({
        method: 'POST',
        url: '/api/subjects',
        payload: { name: 'Tree', path: courseDir },
      })
    ).json();

    const root = await h.app.inject({ method: 'GET', url: `/api/subjects/${created.id}/tree` });
    expect(root.statusCode).toBe(200);
    expect(root.json().entries.map((e: { name: string }) => e.name).sort()).toEqual([
      'graphify-out',
      'lessons',
      'material',
      'reference',
    ]);

    const mat = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${created.id}/tree?dir=material`,
    });
    expect(mat.statusCode).toBe(200);
    const entry = mat.json().entries.find((e: { name: string }) => e.name === 'week1');
    expect(entry.path).toBe('material/week1');
    expect(entry.dir).toBe('material');

    const evil = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${created.id}/tree?dir=../`,
    });
    expect(evil.statusCode).toBe(400);
    expect(evil.json().error.code).toBe('PATH_TRAVERSAL');

    const outside = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${created.id}/tree?dir=material/../../..`,
    });
    expect(outside.statusCode).toBe(400);

    const notFound = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${created.id}/tree?dir=lessons/does-not-exist`,
    });
    expect(notFound.statusCode).toBe(404);
    await rm(courseDir, { recursive: true, force: true });
  });
});
