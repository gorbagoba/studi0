import { describe, expect, it, afterEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { makeHarness } from './helpers';

let h: Awaited<ReturnType<typeof makeHarness>>;

afterEach(async () => {
  if (h) await h.close();
});

function multipartBody(boundary: string, files: { name: string; content: string }[]): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.from(f.content));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat(chunks),
  };
}

async function createSubject(name: string): Promise<string> {
  const res = await h.app.inject({ method: 'POST', url: '/api/subjects', payload: { name } });
  return (res.json() as { id: string }).id;
}

describe('batch upload (T03 / AC2)', () => {
  it('accepts pdf+md, rejects others per-file, lands in material/', async () => {
    h = await makeHarness();
    const id = await createSubject('Up');
    const b = multipartBody('BND', [
      { name: 'week1.pdf', content: 'PDF' },
      { name: 'notes.md', content: '# notes' },
      { name: 'virus.exe', content: 'X' },
    ]);
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/files`,
      ...b,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accepted.map((a: { name: string }) => a.name).sort()).toEqual([
      'notes.md',
      'week1.pdf',
    ]);
    expect(body.rejected).toEqual([
      { name: 'virus.exe', reason: expect.stringContaining('unsupported type') },
    ]);
    const materialDir = path.join(h.dataDir, 'subjects', 'Up', 'material');
    const landed = await readdir(materialDir);
    expect(landed.sort()).toEqual(['notes.md', 'week1.pdf']);
    expect(await readFile(path.join(materialDir, 'week1.pdf'), 'utf8')).toBe('PDF');
  });

  it('returns 415 only when nothing at all was acceptable', async () => {
    h = await makeHarness();
    const id = await createSubject('Up2');
    const b = multipartBody('BND', [
      { name: 'a.exe', content: 'x' },
      { name: 'b.gif', content: 'y' },
    ]);
    const res = await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/files`, ...b });
    expect(res.statusCode).toBe(415);
    const body = res.json();
    expect(body.error.code).toBe('UNSUPPORTED_FILE_TYPE');
    expect(body.error.details.rejected).toHaveLength(2);
    expect(body.error.message).toContain('unsupported type');
  });

  it('sanitizes dangerous names and suffixes collisions', async () => {
    h = await makeHarness();
    const id = await createSubject('Up3');
    const first = multipartBody('BND', [{ name: 'slide.pdf', content: 'one' }]);
    await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/files`, ...first });
    const second = multipartBody('BND', [
      { name: 'slide.pdf', content: 'two' },
      { name: '..\\..\\evil.pdf', content: 'three' },
    ]);
    const res = await h.app.inject({ method: 'POST', url: `/api/subjects/${id}/files`, ...second });
    expect(res.statusCode).toBe(200);
    const names = res.json().accepted.map((a: { name: string }) => a.name).sort();
    expect(names).toEqual(['evil.pdf', 'slide-1.pdf']);
    // collision-suffixed file kept its content; nothing escaped material/
    const materialDir = path.join(h.dataDir, 'subjects', 'Up3', 'material');
    expect(await readFile(path.join(materialDir, 'slide-1.pdf'), 'utf8')).toBe('two');
    expect((await readdir(materialDir)).length).toBe(3);
    const outside = path.resolve(h.dataDir, 'subjects', 'Up3', 'evil.pdf');
    await expect(readFile(outside)).rejects.toThrow();
  });

  it('validates the subject and empty payloads', async () => {
    h = await makeHarness();
    const res404 = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/00000000-0000-0000-0000-000000000000/files`,
      ...multipartBody('BND', [{ name: 'a.pdf', content: 'x' }]),
    });
    expect(res404.statusCode).toBe(404);
    const id = await createSubject('Up4');
    const empty = await h.app.inject({
      method: 'POST',
      url: `/api/subjects/${id}/files`,
      headers: { 'content-type': 'multipart/form-data; boundary=BND' },
      payload: '--BND--\r\n',
    });
    expect(empty.statusCode).toBe(400);
  });
});
