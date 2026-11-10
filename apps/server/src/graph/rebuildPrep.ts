import { existsSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { safeResolve } from '../fs/paths.js';

/** Stale build state the server clears before a rebuild; nothing else is touched. */
const STALE = [
  'graphify-out/cache',
  'graphify-out/.graphify_analysis.json',
  'graphify-out/.graphify_semantic_marker',
  'graphify-out/manifest.json',
];

export interface RebuildPrep {
  backedUp: boolean;
  cleared: string[];
}

/**
 * Server-owned rebuild prep: back up the previous graph, then clear only the
 * listed stale build state. Any failure throws before an agent can run.
 */
export async function prepareRebuild(
  subjectPath: string,
  log: (message: string) => void = () => undefined,
): Promise<RebuildPrep> {
  const graph = safeResolve(subjectPath, 'graphify-out/graph.json');
  if (!existsSync(graph)) {
    log('rebuild prep: no previous graph');
    return { backedUp: false, cleared: [] };
  }
  await copyFile(graph, safeResolve(subjectPath, 'graphify-out/graph.json.pre-rebuild.bak'));
  const cleared: string[] = [];
  for (const rel of STALE) {
    const abs = safeResolve(subjectPath, rel);
    if (!existsSync(abs)) continue;
    await rm(abs, { recursive: true, force: true });
    cleared.push(rel);
  }
  const names = cleared.map((rel) => path.basename(rel)).join(', ');
  log(`rebuild prep: backed up graph.json, cleared ${names || 'nothing'}`);
  return { backedUp: true, cleared };
}
