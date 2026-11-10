import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderLessonPng } from '../src/teacher/render.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true, maxRetries: 3 })));
});

async function lesson(): Promise<{ root: string; rel: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'studi0-render-test-'));
  roots.push(root);
  await mkdir(path.join(root, 'lessons'), { recursive: true });
  await writeFile(path.join(root, 'lessons', '0001-a.html'), '<!DOCTYPE html><html></html>');
  return { root, rel: 'lessons/0001-a.html' };
}

const screenshotPath = (args: string[]): string =>
  args.find((a) => a.startsWith('--screenshot='))!.slice('--screenshot='.length);

describe('renderLessonPng', () => {
  it('runs the injected browser, returns the PNG buffer and cleans up', async () => {
    const { root, rel } = await lesson();
    let shot = '';
    const buf = await renderLessonPng(root, rel, {
      browserBin: 'fake-browser',
      run: async (_bin, args) => {
        shot = screenshotPath(args);
        await writeFile(shot, PNG);
      },
    });
    expect(buf?.equals(PNG)).toBe(true);
    await expect(stat(shot)).rejects.toThrow(); // temp png removed with the temp dir
  });

  it('returns null when no browser can run', async () => {
    const { root, rel } = await lesson();
    const buf = await renderLessonPng(root, rel, {
      browserBin: 'missing',
      run: async () => {
        throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(buf).toBeNull();
  });

  it('returns null on a nonzero exit', async () => {
    const { root, rel } = await lesson();
    const buf = await renderLessonPng(root, rel, {
      browserBin: 'broken',
      run: async () => {
        throw Object.assign(new Error('exit 1'), { code: 1 });
      },
    });
    expect(buf).toBeNull();
  });

  it('returns null and never launches a browser for a path outside the subject', async () => {
    const { root } = await lesson();
    let called = 0;
    const buf = await renderLessonPng(root, '../escape.html', {
      browserBin: 'fake-browser',
      run: async () => {
        called++;
      },
    });
    expect(buf).toBeNull();
    expect(called).toBe(0);
  });
});
