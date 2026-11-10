import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

export interface MaterialFile {
  relPath: string;
  bytes: number;
}

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
