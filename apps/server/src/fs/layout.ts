import { mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeWriteFile } from './safeWrite.js';

const SUBJECT_DIRS = [
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

// canonical agent files: apps/server/agents/*.md
const agentDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents');
const AGENT_FILES = ['studi0-teacher.md', 'studi0-pipeline.md'] as const;

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

/**
 * Sync the canonical agent files into the subject, interpolating the runtime
 * placeholders: {{CHUNK_CONCURRENCY}} in studi0-pipeline.md (the file itself
 * ships with the placeholder; the number is runtime config so pnpm calibrate
 * can change it) and {{HARNESS}} (the user's coding harness, setup-configured).
 */
export async function syncTeacherAgent(subjectRoot: string, chunkConcurrency: number, harness = 'opencode'): Promise<void> {
  for (const name of AGENT_FILES) {
    const src = path.join(agentDir, name);
    if (!existsSync(src)) continue;
    const content = (await readFile(src, 'utf8'))
      .replaceAll('{{CHUNK_CONCURRENCY}}', String(chunkConcurrency))
      .replaceAll('{{HARNESS}}', harness);
    await safeWriteFile(path.join(subjectRoot, '.opencode', 'agents', name), content);
  }
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
