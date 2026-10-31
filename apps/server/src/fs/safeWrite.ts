import { mkdir, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write temp-then-rename: survives OneDrive/AV locks on Documents\Y2 stuff.
 * One rename retry before surfacing the error.
 */
export async function safeWriteFile(filePath: string, data: string | Uint8Array): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, data);
  try {
    await renameWithRetry(tmp, filePath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch {
    await new Promise((r) => setTimeout(r, 150));
    await rename(from, to);
  }
}
