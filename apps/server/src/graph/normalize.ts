import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

/** Copy every child of `from` into `to` (overwriting). The source is removed by the caller. */
async function moveChildren(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from)) {
    await cp(path.join(from, name), path.join(to, name), { recursive: true, force: true });
  }
}

/**
 * graphify writes next to wherever it was run, so an agent that `cd`-ed into
 * graphify-out produces graphify-out/graphify-out/. Flatten before the runner's
 * "graph.json exists?" check. Best-effort: every failure is logged, never thrown.
 */
export async function normalizeGraphifyOutput(
  subjectPath: string,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  try {
    const root = path.join(subjectPath, 'graphify-out');
    const nested = path.join(root, 'graphify-out');
    if (existsSync(path.join(nested, 'graph.json'))) {
      await moveChildren(nested, root);
      await rm(nested, { recursive: true, force: true });
      log('normalised nested graphify-out → graphify-out');
    }
    // a stray material/graphify-out only survives when the root graph is missing
    const stray = path.join(subjectPath, 'material', 'graphify-out');
    if (existsSync(stray)) {
      if (existsSync(path.join(root, 'graph.json'))) {
        await rm(stray, { recursive: true, force: true });
        log('removed stray material/graphify-out (root graph.json present)');
      } else {
        await moveChildren(stray, root);
        await rm(stray, { recursive: true, force: true });
        log('normalised material/graphify-out → graphify-out');
      }
    }
  } catch (e) {
    log(`graphify-out normalisation failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
