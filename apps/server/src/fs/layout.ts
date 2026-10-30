import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeWriteFile } from './safeWrite.js';

export const SUBJECT_DIRS = [
  'material',
  'lessons',
  'reference',
  'learning-records',
  'graphify-out',
  'graphify-out/wiki',
  'assets',
  '.opencode/agents',
] as const;

const LAYOUT_FILES = ['corrections.md', 'MISSION.md', 'NOTES.md', 'RESOURCES.md'] as const;

// canonical agent file: apps/server/agents/studi0-teacher.md
const agentSourcePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'agents',
  'studi0-teacher.md',
);

/** Idempotently ensure the teach-workspace layout under a subject root. */
export async function ensureLayout(subjectRoot: string): Promise<void> {
  for (const dir of SUBJECT_DIRS) {
    await mkdir(path.join(subjectRoot, dir), { recursive: true });
  }
  for (const file of LAYOUT_FILES) {
    const p = path.join(subjectRoot, file);
    if (!existsSync(p)) await safeWriteFile(p, '');
  }
}

/** Sync the canonical teacher agent file into the subject (byte-identical overwrite). */
export async function syncTeacherAgent(subjectRoot: string): Promise<void> {
  if (!existsSync(agentSourcePath)) return;
  const content = await readFile(agentSourcePath, 'utf8');
  const dest = path.join(subjectRoot, '.opencode', 'agents', 'studi0-teacher.md');
  await safeWriteFile(dest, content);
}

/** Mirror existing material/ files into the files table (origin 'seed'). */
export async function seedFileRows(
  subjectRoot: string,
  onFile: (relPath: string, bytes: number, mtimeIso: string) => void,
): Promise<void> {
  const materialDir = path.join(subjectRoot, 'material');
  if (!existsSync(materialDir)) return;
  await walk(materialDir, (abs) => {
    const s = statSync(abs);
    const rel = path.relative(subjectRoot, abs).replaceAll('\\', '/');
    onFile(rel, s.size, s.mtime.toISOString());
  });
}

async function walk(dir: string, on: (abs: string) => void): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, on);
    else if (entry.isFile()) on(abs);
  }
}

/** Read the canonical agent file source (used by tests to assert sync). */
export async function readCanonicalAgent(): Promise<string | null> {
  if (!existsSync(agentSourcePath)) return null;
  return readFile(agentSourcePath, 'utf8');
}
