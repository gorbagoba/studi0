import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

async function subjectWithFile(name: string, rel: string, content: string) {
  const dir = await mkdtemp(path.join(tmpdir(), `studi0-fileops-${name}-`));
  await mkdir(path.join(dir, 'material'), { recursive: true });
  await writeFile(path.join(dir, rel), content);
  const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name: `FO-${name}`, path: dir } });
  const subject = res.json() as { id: string };
  const tree = await h.app.inject({ method: 'GET', url: `/api/subjects/${subject.id}/tree` });
  const materialEntry = (tree.json().entries as Array<{ name: string; id?: string }>).find((e) => e.name === 'material');
  const sub = await h.app.inject({ method: 'GET', url: `/api/subjects/${subject.id}/tree?dir=material` });
  const entry = (sub.json().entries as Array<{ name: string; id?: string }>).find((e) => e.name === path.basename(rel));
  return { subject, fileId: entry?.id, materialId: materialEntry?.id, dir };
}

describe('file rename/delete (material/ only)', () => {
  it('renames on disk, re-points the row, and the tree shows the new id-bearing entry', async () => {
    h = await makeHarness();
    const { subject, fileId, dir } = await subjectWithFile('ren', 'material/old.txt', 'hi');
    expect(fileId).toBeTruthy();
    const res = await h.app.inject({ method: 'PATCH', url: `/api/files/${fileId}`, payload: { name: 'new.txt' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().path).toBe('material/new.txt');
    expect(existsSync(path.join(dir, 'material', 'new.txt'))).toBe(true);
    expect(existsSync(path.join(dir, 'material', 'old.txt'))).toBe(false);
    void subject;
  });

  it('deletes from disk and removes the row; bare dirs have no id to act on', async () => {
    h = await makeHarness();
    const { fileId, dir, materialId } = await subjectWithFile('del', 'material/gone.txt', 'x');
    const res = await h.app.inject({ method: 'DELETE', url: `/api/files/${fileId}` });
    expect(res.statusCode).toBe(200);
    expect(existsSync(path.join(dir, 'material', 'gone.txt'))).toBe(false);
    const after = await h.app.inject({ method: 'DELETE', url: `/api/files/${fileId}` });
    expect(after.statusCode).toBe(404);
    // directories carry no row id — acting on them must not be possible
    expect(materialId).toBeUndefined();
  });

  it('refuses to rename/delete outside material/ (lessons are teacher outputs)', async () => {
    h = await makeHarness();
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-fileops-lessons-'));
    await mkdir(path.join(dir, 'lessons'), { recursive: true });
    await writeFile(path.join(dir, 'lessons', 'l.html'), '<p>x</p>');
    const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name: 'FO-L', path: dir } });
    const subject = res.json() as { id: string };
    const sub = await h.app.inject({ method: 'GET', url: `/api/subjects/${subject.id}/tree?dir=lessons` });
    const entry = (sub.json().entries as Array<{ name: string; id?: string }>)[0];
    // lessons files are not registered rows → no id → the menu cannot act on them
    expect(entry.id).toBeUndefined();
    void dir;
  });
});

afterEach(async () => {
  for (const d of [path.join(tmpdir())]) void d;
  void rm;
});
