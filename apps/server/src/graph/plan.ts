import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface MaterialFile {
  relPath: string;
  bytes: number;
}

export interface ChunkPlanOptions {
  maxChunks: number;
  maxFilesPerChunk: number;
  maxBytesPerChunk: number;
}

/** Deterministic planner limits: ≤24 chunks of ≤8 files / 8 MB. */
export const PLAN_LIMITS: ChunkPlanOptions = {
  maxChunks: 24,
  maxFilesPerChunk: 8,
  maxBytesPerChunk: 8 * 1024 * 1024,
};

/** Every regular file under material/ (recursive, no graphify cache), with sizes. */
export async function listMaterialFiles(subjectPath: string): Promise<MaterialFile[]> {
  const files: MaterialFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const relPath = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'graphify-out') continue; // pipeline cache, not course material
        await walk(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        const s = await stat(path.join(dir, entry.name)).catch(() => null);
        if (s) files.push({ relPath, bytes: s.size });
      }
    }
  };
  await walk(path.join(subjectPath, 'material'), 'material');
  return files.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Group material files into roughly equal chunks by size (longest-processing-time):
 * no model call, deterministic for the same inputs, caps honoured unless one file
 * alone exceeds maxBytesPerChunk.
 */
export function planChunks(files: MaterialFile[], options: ChunkPlanOptions): MaterialFile[][] {
  if (files.length === 0) return [];
  const maxChunks = Math.max(1, Math.floor(options.maxChunks) || 1);
  const maxFiles = Math.max(1, Math.floor(options.maxFilesPerChunk) || 1);
  const maxBytes = Math.max(1, Math.floor(options.maxBytesPerChunk) || 1);
  const totalBytes = files.reduce((n, f) => n + Math.max(0, f.bytes), 0);
  const count = Math.min(
    maxChunks,
    Math.max(1, Math.ceil(files.length / maxFiles), Math.ceil(totalBytes / maxBytes)),
  );
  const bins: MaterialFile[][] = Array.from({ length: count }, () => []);
  const loads = new Array<number>(count).fill(0);
  const ordered = [...files].sort((a, b) => b.bytes - a.bytes || a.relPath.localeCompare(b.relPath));
  for (const file of ordered) {
    const size = Math.max(0, file.bytes);
    let best = -1;
    for (let i = 0; i < count; i++) {
      if (bins[i].length >= maxFiles || loads[i] + size > maxBytes) continue;
      if (best === -1 || loads[i] < loads[best]) best = i;
    }
    if (best === -1) {
      // shortcut: maxChunks too small (or one file above maxBytesPerChunk) forces overflow; raise maxChunks
      for (let i = 0; i < count; i++) if (best === -1 || loads[i] < loads[best]) best = i;
    }
    bins[best].push(file);
    loads[best] += size;
  }
  return bins
    .filter((bin) => bin.length > 0)
    .map((bin) => bin.sort((a, b) => a.relPath.localeCompare(b.relPath)));
}
