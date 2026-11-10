import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeConfig } from '../src/config.js';

const saved = { ...process.env };
const made: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const win = process.platform === 'win32';

afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

async function tempVenv(binFile: boolean): Promise<string> {
  const venv = await mkdtemp(path.join(tmpdir(), 'studi0-venv-'));
  made.push(venv);
  if (binFile) {
    const binDir = path.join(venv, win ? 'Scripts' : 'bin');
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(binDir, win ? 'graphify.exe' : 'graphify'), '');
  }
  return venv;
}

describe('graphify venv config', () => {
  it('defaults graphifyVenv to <repo>/.graphify-venv', () => {
    delete process.env.STUDI0_GRAPHIFY_VENV;
    expect(makeConfig('/tmp/studi0-venv').graphifyVenv).toBe(path.resolve(repoRoot, '.graphify-venv'));
  });

  it('derives graphifyBin from the venv when the platform bin exists', async () => {
    const venv = await tempVenv(true);
    process.env.STUDI0_GRAPHIFY_VENV = venv;
    delete process.env.GRAPHIFY_BIN;
    const cfg = makeConfig('/tmp/studi0-venv');
    expect(cfg.graphifyVenv).toBe(path.resolve(venv));
    expect(cfg.graphifyBin).toBe(path.join(path.resolve(venv), win ? 'Scripts' : 'bin', win ? 'graphify.exe' : 'graphify'));
  });

  it('falls back to bare graphify when the venv has no bin, and honours GRAPHIFY_BIN', async () => {
    const venv = await tempVenv(false);
    process.env.STUDI0_GRAPHIFY_VENV = venv;
    delete process.env.GRAPHIFY_BIN;
    expect(makeConfig('/tmp/studi0-venv').graphifyBin).toBe('graphify');

    process.env.GRAPHIFY_BIN = path.join(venv, 'custom-graphify');
    expect(makeConfig('/tmp/studi0-venv').graphifyBin).toBe(process.env.GRAPHIFY_BIN);
  });
});
