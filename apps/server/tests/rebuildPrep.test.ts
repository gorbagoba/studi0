import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareRebuild } from '../src/graph/rebuildPrep.js';

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

async function subject(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'studi0-rebuild-'));
  made.push(dir);
  await mkdir(path.join(dir, 'graphify-out', 'cache'), { recursive: true });
  await mkdir(path.join(dir, 'material'), { recursive: true });
  await writeFile(path.join(dir, 'material', 'keep.md'), 'course material');
  await writeFile(path.join(dir, 'graphify-out', 'graph.html'), '<html></html>');
  return dir;
}

const STALE = [
  'graphify-out/cache',
  'graphify-out/.graphify_analysis.json',
  'graphify-out/.graphify_semantic_marker',
  'graphify-out/manifest.json',
];

async function stageStale(dir: string): Promise<void> {
  await writeFile(path.join(dir, 'graphify-out', 'cache', 'chunk.json'), '{}');
  await writeFile(path.join(dir, 'graphify-out', '.graphify_analysis.json'), '{}');
  await writeFile(path.join(dir, 'graphify-out', '.graphify_semantic_marker'), 'x');
  await writeFile(path.join(dir, 'graphify-out', 'manifest.json'), '{}');
}

describe('prepareRebuild', () => {
  it('backs up graph.json and clears only the listed build state', async () => {
    const dir = await subject();
    await stageStale(dir);
    const graph = JSON.stringify({ nodes: [{ id: 'a', label: 'A' }] });
    await writeFile(path.join(dir, 'graphify-out', 'graph.json'), graph);
    const lines: string[] = [];

    const result = await prepareRebuild(dir, (line) => lines.push(line));

    expect(result).toEqual({ backedUp: true, cleared: STALE });
    await expect(
      readFile(path.join(dir, 'graphify-out', 'graph.json.pre-rebuild.bak'), 'utf8'),
    ).resolves.toBe(graph);
    for (const rel of STALE) expect(existsSync(path.join(dir, rel)), rel).toBe(false);
    // keepers: the graph, its HTML export and course material
    expect(existsSync(path.join(dir, 'graphify-out', 'graph.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'graphify-out', 'graph.html'))).toBe(true);
    expect(existsSync(path.join(dir, 'material', 'keep.md'))).toBe(true);
    expect(lines).toEqual([
      'rebuild prep: backed up graph.json, cleared cache, .graphify_analysis.json, .graphify_semantic_marker, manifest.json',
    ]);
  });

  it('is a no-op backup when there is no previous graph', async () => {
    const dir = await subject();
    const lines: string[] = [];

    const result = await prepareRebuild(dir, (line) => lines.push(line));

    expect(result).toEqual({ backedUp: false, cleared: [] });
    expect(existsSync(path.join(dir, 'graphify-out', 'graph.json.pre-rebuild.bak'))).toBe(false);
    expect(existsSync(path.join(dir, 'graphify-out', 'cache'))).toBe(true);
    expect(lines).toEqual(['rebuild prep: no previous graph']);
  });

  it('throws before clearing anything when the backup cannot be written', async () => {
    const dir = await subject();
    await stageStale(dir);
    await writeFile(path.join(dir, 'graphify-out', 'graph.json'), '{"nodes":[]}');
    // a directory at the backup path makes copyFile fail
    await mkdir(path.join(dir, 'graphify-out', 'graph.json.pre-rebuild.bak'));
    await writeFile(path.join(dir, 'graphify-out', 'graph.json.pre-rebuild.bak', 'block'), 'x');

    await expect(prepareRebuild(dir)).rejects.toThrow();
    expect(existsSync(path.join(dir, 'graphify-out', 'cache'))).toBe(true);
    expect(existsSync(path.join(dir, 'graphify-out', 'manifest.json'))).toBe(true);
  });
});
