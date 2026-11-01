import { describe, expect, it, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeHarness, type TestHarness } from './helpers';

let h: TestHarness | undefined;

afterEach(async () => {
  if (h) {
    await h.close();
    h = undefined;
  }
});

async function makeSubject(name: string, dir?: string): Promise<{ id: string; path: string }> {
  const res = await h!.app.inject({
    method: 'POST',
    url: '/api/subjects',
    payload: dir ? { name, path: dir } : { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

function fileRowId(subjectId: string, relPath: string): string {
  const row = h!.ctx.db
    .prepare('SELECT id FROM files WHERE subject_id = ? AND rel_path = ?')
    .get(subjectId, relPath) as { id: string } | undefined;
  expect(row, `file row ${relPath} should exist`).toBeTruthy();
  return (row as { id: string }).id;
}

describe('groups (T-S1)', () => {
  it('creates, lists with subject counts, renames, rejects duplicates', async () => {
    h = await makeHarness();
    const g = (
      await h.app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'MATH' } })
    ).json();
    expect(g.name).toBe('MATH');
    expect(g.subjectCount).toBe(0);

    const dup = await h.app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'MATH' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('NAME_TAKEN');

    const s = await makeSubject('CS2040C');
    const moved = await h.app.inject({
      method: 'PATCH',
      url: `/api/subjects/${s.id}`,
      payload: { name: 'CS2040C', groupId: g.id },
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().groupId).toBe(g.id);
    expect(moved.json().groupName).toBe('MATH');

    const list = (await h.app.inject({ method: 'GET', url: '/api/groups' })).json();
    expect(list).toHaveLength(1);
    expect(list[0].subjectCount).toBe(1);

    const renamed = await h.app.inject({
      method: 'PATCH',
      url: `/api/groups/${g.id}`,
      payload: { name: 'YEAR 2' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('YEAR 2');
    expect(renamed.json().subjectCount).toBe(1);

    const dupRename = await h.app.inject({
      method: 'PATCH',
      url: `/api/groups/${g.id}`,
      payload: { name: 'YEAR 2' },
    });
    expect(dupRename.statusCode).toBe(409);
  });

  it('ungroups subjects on delete and never deletes the subjects', async () => {
    h = await makeHarness();
    const g = (
      await h.app.inject({ method: 'POST', url: '/api/groups', payload: { name: 'G' } })
    ).json();
    const s1 = await makeSubject('One');
    const s2 = await makeSubject('Two');
    for (const s of [s1, s2]) {
      await h.app.inject({
        method: 'PATCH',
        url: `/api/subjects/${s.id}`,
        payload: { name: s.id === s1.id ? 'One' : 'Two', groupId: g.id },
      });
    }
    const del = await h.app.inject({ method: 'DELETE', url: `/api/groups/${g.id}` });
    expect(del.statusCode).toBe(200);
    expect(del.json().ok).toBe(true);
    for (const s of [s1, s2]) {
      const dto = (await h.app.inject({ method: 'GET', url: `/api/subjects/${s.id}` })).json();
      expect(dto.groupId).toBeNull();
      expect(dto.groupName).toBeNull();
    }
    expect((await h.app.inject({ method: 'GET', url: '/api/groups' })).json()).toEqual([]);

    const missing = await h.app.inject({ method: 'DELETE', url: `/api/groups/${g.id}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('GROUP_NOT_FOUND');
  });

  it('rejects unknown groupId on the subject patch with 404', async () => {
    h = await makeHarness();
    const s = await makeSubject('X');
    const res = await h.app.inject({
      method: 'PATCH',
      url: `/api/subjects/${s.id}`,
      payload: { name: 'X', groupId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('GROUP_NOT_FOUND');
  });
});

describe('merge-into (T-S1)', () => {
  it('moves material files, skips collisions, keeps outputs and the source registered', async () => {
    h = await makeHarness();
    const srcDir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-src-'));
    const dstDir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-dst-'));
    await mkdir(path.join(srcDir, 'material', 'week1'), { recursive: true });
    await writeFile(path.join(srcDir, 'material', 'a.pdf'), 'SOURCE-A');
    await writeFile(path.join(srcDir, 'material', 'week1', 'b.md'), 'SOURCE-B');
    await mkdir(path.join(srcDir, 'graphify-out', 'wiki'), { recursive: true });
    await writeFile(path.join(srcDir, 'graphify-out', 'graph.json'), '{"v":1}');
    await mkdir(path.join(dstDir, 'material'), { recursive: true });
    await writeFile(path.join(dstDir, 'material', 'a.pdf'), 'TARGET-A'); // collision
    const src = await makeSubject('Src', srcDir);
    const dst = await makeSubject('Dst', dstDir);

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${src.id}/merge-into`,
      payload: { targetId: dst.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().moved).toEqual(['material/week1/b.md']);
    expect(res.json().skipped).toEqual(['material/a.pdf']);

    // disk: moved file arrived, collision kept the target's bytes, source emptied
    await expect(readFile(path.join(dstDir, 'material', 'week1', 'b.md'), 'utf8')).resolves.toBe('SOURCE-B');
    await expect(readFile(path.join(dstDir, 'material', 'a.pdf'), 'utf8')).resolves.toBe('TARGET-A');
    expect(existsSync(path.join(srcDir, 'material', 'week1', 'b.md'))).toBe(false);
    // a skipped collision stays untouched in the source
    await expect(readFile(path.join(srcDir, 'material', 'a.pdf'), 'utf8')).resolves.toBe('SOURCE-A');
    // outputs stay with their subject
    expect(readFile(path.join(srcDir, 'graphify-out', 'graph.json'), 'utf8')).toBeTruthy();

    // rows re-pointed, source still registered and material-empty
    const row = h.ctx.db
      .prepare('SELECT subject_id FROM files WHERE rel_path = ?')
      .get('material/week1/b.md') as { subject_id: string };
    expect(row.subject_id).toBe(dst.id);
    const srcDetail = (await h.app.inject({ method: 'GET', url: `/api/subjects/${src.id}` })).json();
    expect(srcDetail.id).toBe(src.id);

    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  });

  it('refuses self-merge and unknown targets', async () => {
    h = await makeHarness();
    const src = await makeSubject('SelfMerge');
    const self = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${src.id}/merge-into`,
      payload: { targetId: src.id },
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('VALIDATION');

    const missing = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${src.id}/merge-into`,
      payload: { targetId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SUBJECT_NOT_FOUND');
  });
});

describe('delete-files-from-disk (T-S1)', () => {
  it('deletes the subject root, closes rows and unregisters (happy path)', async () => {
    h = await makeHarness();
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-del-'));
    await mkdir(path.join(dir, 'material'), { recursive: true });
    await writeFile(path.join(dir, 'material', 'x.pdf'), 'X');
    const s = await makeSubject('Doomed', dir);

    const res = await h.app.inject({ method: 'POST', url: `/api/subjects/${s.id}/delete-files` });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(existsSync(s.path)).toBe(false);
    const after = await h.app.inject({ method: 'GET', url: `/api/subjects/${s.id}` });
    expect(after.statusCode).toBe(404);
  });

  it('refuses while a job is queued/running/cancelling (folder untouched)', async () => {
    h = await makeHarness();
    const s = await makeSubject('Busy');
    h.ctx.db
      .prepare(
        "INSERT INTO jobs (id, subject_id, kind, status, created_at) VALUES ('j-busy', ?, 'build', 'running', ?)",
      )
      .run(s.id, new Date().toISOString());

    const res = await h.app.inject({ method: 'POST', url: `/api/subjects/${s.id}/delete-files` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('JOB_CONFLICT');
    expect(existsSync(s.path)).toBe(true);
  });

  it('refuses when the folder on disk no longer realpaths to the registered path', async () => {
    h = await makeHarness();
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-swap-'));
    const s = await makeSubject('Swapped', dir);
    const evil = await mkdtemp(path.join(tmpdir(), 'studi0-w3-evil-'));
    await writeFile(path.join(evil, 'precious.txt'), 'DO NOT DELETE');

    // swap the registered folder for a junction pointing at an unrelated dir
    await rm(dir, { recursive: true, force: true });
    await symlink(evil, dir, 'junction');
    try {
      const res = await h.app.inject({ method: 'POST', url: `/api/subjects/${s.id}/delete-files` });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('PATH_TRAVERSAL');
      expect(existsSync(path.join(evil, 'precious.txt'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true }); // removes the junction only
      await rm(evil, { recursive: true, force: true });
    }
  });

  it('refuses when the folder is already gone from disk', async () => {
    h = await makeHarness();
    const dir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-gone-'));
    const s = await makeSubject('Gone', dir);
    await rm(dir, { recursive: true, force: true });
    const res = await h.app.inject({ method: 'POST', url: `/api/subjects/${s.id}/delete-files` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('PATH_NOT_FOUND');
  });
});

describe('per-file move (T-S1)', () => {
  it('moves a material file + its row into the target subject', async () => {
    h = await makeHarness();
    const srcDir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-mv-'));
    await mkdir(path.join(srcDir, 'material'), { recursive: true });
    await writeFile(path.join(srcDir, 'material', 'x.md'), 'MOVE-ME');
    const src = await makeSubject('MoveSrc', srcDir);
    const dst = await makeSubject('MoveDst');

    const fileId = fileRowId(src.id, 'material/x.md');
    const moved = await h.app.inject({
      method: 'POST',
      url: `/api/files/${fileId}/move`,
      payload: { targetSubjectId: dst.id },
    });
    expect(moved.statusCode).toBe(200);
    const row = moved.json();
    expect(row.id).toBe(fileId);
    expect(row.subjectId).toBe(dst.id);
    expect(row.path).toBe('material/x.md');
    expect(existsSync(path.join(dst.path, 'material', 'x.md'))).toBe(true);
    expect(existsSync(path.join(src.path, 'material', 'x.md'))).toBe(false);
    const owner = h.ctx.db.prepare('SELECT subject_id FROM files WHERE id = ?').get(fileId) as {
      subject_id: string;
    };
    expect(owner.subject_id).toBe(dst.id);
    await rm(srcDir, { recursive: true, force: true });
  });

  it('refuses collisions with 409 NAME_TAKEN and unknown ids with 404', async () => {
    h = await makeHarness();
    const srcDir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-cs-'));
    const dstDir = await mkdtemp(path.join(tmpdir(), 'studi0-w3-cd-'));
    await mkdir(path.join(srcDir, 'material'), { recursive: true });
    await mkdir(path.join(dstDir, 'material'), { recursive: true });
    await writeFile(path.join(srcDir, 'material', 'same.md'), 'SRC');
    await writeFile(path.join(dstDir, 'material', 'same.md'), 'DST');
    const src = await makeSubject('CollSrc', srcDir);
    const dst = await makeSubject('CollDst', dstDir);
    const fileId = fileRowId(src.id, 'material/same.md');

    const res = await h.app.inject({
      method: 'POST',
      url: `/api/files/${fileId}/move`,
      payload: { targetSubjectId: dst.id },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('NAME_TAKEN');
    await expect(readFile(path.join(srcDir, 'material', 'same.md'), 'utf8')).resolves.toBe('SRC');
    await expect(readFile(path.join(dstDir, 'material', 'same.md'), 'utf8')).resolves.toBe('DST');

    const noFile = await h.app.inject({
      method: 'POST',
      url: '/api/files/00000000-0000-4000-8000-000000000000/move',
      payload: { targetSubjectId: dst.id },
    });
    expect(noFile.statusCode).toBe(404);
    expect(noFile.json().error.code).toBe('FILE_NOT_FOUND');

    const noSubject = await h.app.inject({
      method: 'POST',
      url: `/api/files/${fileId}/move`,
      payload: { targetSubjectId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(noSubject.statusCode).toBe(404);
    expect(noSubject.json().error.code).toBe('SUBJECT_NOT_FOUND');
    await rm(srcDir, { recursive: true, force: true });
    await rm(dstDir, { recursive: true, force: true });
  });

  it('only moves material/ files', async () => {
    h = await makeHarness();
    const src = await makeSubject('LessSrc');
    const dst = await makeSubject('LessDst');
    h.ctx.db
      .prepare(
        "INSERT INTO files (id, subject_id, rel_path, bytes, mtime, origin) VALUES ('f-lesson', ?, 'lessons/0001.html', 3, '2026-01-01T00:00:00.000Z', 'seed')",
      )
      .run(src.id);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/files/f-lesson/move',
      payload: { targetSubjectId: dst.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });
});
