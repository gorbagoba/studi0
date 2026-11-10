import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeGraphifyOutput } from '../src/graph/normalize.js';

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

async function tempSubject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-normalize-'));
  made.push(dir);
  return dir;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('normalizeGraphifyOutput', () => {
  it('flattens a nested graphify-out and keeps existing root artifacts', async () => {
    const dir = await tempSubject();
    const root = path.join(dir, 'graphify-out');
    const nested = path.join(root, 'graphify-out');
    await mkdir(path.join(root, 'chunks'), { recursive: true });
    await writeFile(path.join(root, 'chunks', 'chunk-01.md'), 'chunk');
    await mkdir(path.join(nested, 'wiki'), { recursive: true });
    await mkdir(path.join(nested, 'cache'), { recursive: true });
    await writeFile(path.join(nested, 'graph.json'), '{"nested":true}');
    await writeFile(path.join(nested, 'wiki', 'page.md'), 'wiki');
    await writeFile(path.join(nested, 'cache', 'c.json'), '{}');
    const lines: string[] = [];

    await normalizeGraphifyOutput(dir, (m) => lines.push(m));

    expect(await readFile(path.join(root, 'graph.json'), 'utf8')).toBe('{"nested":true}');
    expect(await readFile(path.join(root, 'wiki', 'page.md'), 'utf8')).toBe('wiki');
    expect(await exists(path.join(root, 'cache', 'c.json'))).toBe(true);
    expect(await exists(path.join(root, 'chunks', 'chunk-01.md'))).toBe(true);
    expect(await exists(nested)).toBe(false);
    expect(lines).toContain('normalised nested graphify-out → graphify-out');
  });

  it('moves a stray material/graphify-out up when the root has no graph.json', async () => {
    const dir = await tempSubject();
    const stray = path.join(dir, 'material', 'graphify-out');
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, 'graph.json'), '{"stray":true}');
    const lines: string[] = [];

    await normalizeGraphifyOutput(dir, (m) => lines.push(m));

    expect(await readFile(path.join(dir, 'graphify-out', 'graph.json'), 'utf8')).toBe('{"stray":true}');
    expect(await exists(stray)).toBe(false);
    expect(lines).toContain('normalised material/graphify-out → graphify-out');
  });

  it('deletes a stray material/graphify-out when the root already has a graph.json', async () => {
    const dir = await tempSubject();
    await mkdir(path.join(dir, 'graphify-out'), { recursive: true });
    await writeFile(path.join(dir, 'graphify-out', 'graph.json'), '{"root":true}');
    const stray = path.join(dir, 'material', 'graphify-out');
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, 'graph.json'), '{"stray":true}');
    const lines: string[] = [];

    await normalizeGraphifyOutput(dir, (m) => lines.push(m));

    expect(await readFile(path.join(dir, 'graphify-out', 'graph.json'), 'utf8')).toBe('{"root":true}');
    expect(await exists(stray)).toBe(false);
    expect(lines).toHaveLength(1);
  });

  it('is a no-op when neither location exists', async () => {
    const dir = await tempSubject();
    const lines: string[] = [];

    await normalizeGraphifyOutput(dir, (m) => lines.push(m));

    expect(lines).toEqual([]);
    expect(await exists(path.join(dir, 'graphify-out'))).toBe(false);
  });

  it('swallows a write failure instead of throwing', async () => {
    const dir = await tempSubject();
    // graphify-out is a file, so flattening the stray into it cannot work
    await writeFile(path.join(dir, 'graphify-out'), 'not a directory');
    const stray = path.join(dir, 'material', 'graphify-out');
    await mkdir(stray, { recursive: true });
    await writeFile(path.join(stray, 'graph.json'), '{"stray":true}');
    const lines: string[] = [];

    await expect(normalizeGraphifyOutput(dir, (m) => lines.push(m))).resolves.toBeUndefined();

    expect(lines.at(-1)).toContain('graphify-out normalisation failed');
    expect(await exists(path.join(stray, 'graph.json'))).toBe(true);
  });
});
