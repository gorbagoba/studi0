import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sanitizeName, safeResolve } from '../src/fs/paths.js';
import { HttpError } from '../src/util/errors.js';

describe('sanitizeName (Windows reserved stems)', () => {
  it('prefixes reserved stems on any extension', () => {
    expect(sanitizeName('con.pdf')).toBe('_con.pdf');
    expect(sanitizeName('NUL')).toBe('_NUL');
    expect(sanitizeName('com1.md')).toBe('_com1.md');
    expect(sanitizeName('lpt9.txt')).toBe('_lpt9.txt');
    expect(sanitizeName('aux')).toBe('_aux');
  });

  it('leaves normal names alone', () => {
    expect(sanitizeName('constants.pdf')).toBe('constants.pdf');
    expect(sanitizeName('econ.md')).toBe('econ.md');
    expect(sanitizeName('week1.md')).toBe('week1.md');
  });
});

describe('safeResolve symlink/junction containment', () => {
  const made: string[] = [];

  afterEach(async () => {
    for (const dir of made.splice(0)) {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });

  it('refuses paths that resolve through a junction outside the root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studi0-paths-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'studi0-escape-'));
    made.push(root, outside);
    await writeFile(path.join(outside, 'secret.txt'), 'x');
    await symlink(outside, path.join(root, 'link'), 'junction');
    // the lexical check passes (root\link\secret.txt); the realpath check must catch it
    expect(() => safeResolve(root, 'link/secret.txt')).toThrow(HttpError);
    // ordinary (not-yet-existing) paths still resolve
    expect(safeResolve(root, 'material/w1.pdf')).toBe(path.join(root, 'material', 'w1.pdf'));
  });
});
