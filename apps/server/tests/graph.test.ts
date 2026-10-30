import { describe, expect, it, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

async function createSubject(name: string): Promise<{ id: string; root: string }> {
  const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  const body = res.json();
  return { id: body.id, root: body.path };
}

const lessonHtml =
  '<!-- studi0:lesson {"nodes":["n-heaps","n-pq"],"topic":"heaps"} -->\n<html><head><title>Heaps</title></head><body><h1>Heaps</h1></body></html>';

describe('graph / wiki / corrections / lessons (T05)', () => {
  it('graph endpoint derives none → ready from disk, reports both reports', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('G1');
    let info = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph` })).json();
    expect(info.graphStatus).toBe('none');
    expect(info.hasGraph).toBe(false);

    await mkdir(path.join(root, 'graphify-out'), { recursive: true });
    await writeFile(path.join(root, 'graphify-out', 'graph.json'), '{}');
    await writeFile(path.join(root, 'graphify-out', 'GRAPH_REPORT.md'), '# report');
    await writeFile(path.join(root, 'graphify-out', 'VERIFY_REPORT.md'), '## Flagged edges\n- x');
    info = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph` })).json();
    expect(info.graphStatus).toBe('ready');
    expect(info.hasGraph).toBe(true);
    expect(info.hasReport).toBe(true);
    expect(info.hasVerifyReport).toBe(true);

    const report = (
      await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/graph/report` })
    ).json();
    expect(report.graphReport).toContain('# report');
    expect(report.verifyReport).toContain('Flagged');
  });

  it('raw passthrough serves graphify-out files and refuses traversal', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('G2');
    await mkdir(path.join(root, 'graphify-out'), { recursive: true });
    await writeFile(path.join(root, 'graphify-out', 'graph.html'), '<html>graph</html>');
    const ok = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${id}/graph/raw/graph.html`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
    expect(ok.body).toContain('graph');
    const evil = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${id}/graph/raw/../material/secret.pdf`,
    });
    expect([400, 404]).toContain(evil.statusCode);
    const deep = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${id}/graph/raw/%2e%2e%2f%2e%2e%2fpackage.json`,
    });
    expect([400, 404]).toContain(deep.statusCode);
  });

  it('wiki: edit-only PUT, list and read', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('W1');
    await mkdir(path.join(root, 'graphify-out', 'wiki'), { recursive: true });
    await writeFile(path.join(root, 'graphify-out', 'wiki', 'heaps.md'), 'generated');

    const list = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/wiki` })).json();
    expect(list.pages.map((p: { name: string }) => p.name)).toEqual(['heaps.md']);

    const read = await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/wiki/heaps.md` });
    expect(read.json().markdown).toBe('generated');

    const put = await h.app.inject({
      method: 'PUT',
      url: `/api/subjects/${id}/wiki/heaps.md`,
      payload: { markdown: 'student-corrected' },
    });
    expect(put.statusCode).toBe(200);
    const reread = await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/wiki/heaps.md` });
    expect(reread.json().markdown).toBe('student-corrected');

    // PUT must not create pages (US10)
    const create = await h.app.inject({
      method: 'PUT',
      url: `/api/subjects/${id}/wiki/new-page.md`,
      payload: { markdown: 'nope' },
    });
    expect(create.statusCode).toBe(404);
  });

  it('corrections: GET empty, PUT creates/updates', async () => {
    h = await makeHarness();
    const { id } = await createSubject('C1');
    const empty = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/corrections` })).json();
    expect(empty.markdown).toBe('');
    await h.app.inject({
      method: 'PUT',
      url: `/api/subjects/${id}/corrections`,
      payload: { markdown: 'I use the slides notation' },
    });
    const full = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/corrections` })).json();
    expect(full.markdown).toBe('I use the slides notation');
  });

  it('lessons: content endpoint with node-tag parse and traversal guard', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('L1');
    await mkdir(path.join(root, 'lessons'), { recursive: true });
    await writeFile(path.join(root, 'lessons', '0007-heaps.html'), lessonHtml);

    const content = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${id}/lessons/content?path=lessons/0007-heaps.html`,
    });
    expect(content.statusCode).toBe(200);
    const body = content.json();
    expect(body.title).toBe('Heaps');
    expect(body.nodeTags).toEqual(['n-heaps', 'n-pq']);
    expect(body.html).toContain('<h1>Heaps</h1>');

    const evil = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${id}/lessons/content?path=corrections.md`,
    });
    expect([400, 404]).toContain(evil.statusCode);
    const traversal = await h.app.inject({
      method: 'GET',
      url: `/api/subjects/${id}/lessons/content?path=../../package.json`,
    });
    expect(traversal.statusCode).toBe(400);
  });

  it('detects lesson files written during chat turns and indexes them (T06)', async () => {
    h = await makeHarness();
    const { id, root } = await createSubject('L2');
    // simulate what chatStream does on a turn that wrote a lesson
    const { detectAndIndexLessons, snapshotLessons } = await import('../src/teacher/lessons.js');
    const before = await snapshotLessons({ id, path: root } as never);
    await mkdir(path.join(root, 'lessons'), { recursive: true });
    await writeFile(path.join(root, 'lessons', '0001-dijkstra.html'), lessonHtml);
    const rows = await detectAndIndexLessons(h.ctx.db, { id, path: root } as never, before, h.ctx.events);
    expect(rows).toHaveLength(1);
    const lessons = (await h.app.inject({ method: 'GET', url: `/api/subjects/${id}/lessons` })).json();
    expect(lessons[0].title).toBe('Heaps');
    expect(lessons[0].nodeTags).toEqual(['n-heaps', 'n-pq']);
    expect(lessons[0].path).toBe('lessons/0001-dijkstra.html');
    await rm(root, { recursive: true, force: true });
  });
});
