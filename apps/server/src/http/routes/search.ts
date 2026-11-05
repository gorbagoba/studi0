import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import { requireSubject } from '../../subjects/service.js';
import { materialFileMap } from '../../retrieval/chunk.js';
import { ensureIndex } from '../../retrieval/index.js';
import { grepSearch, hybridSearch } from '../../retrieval/search.js';

const searchQuerySchema = z.object({ q: z.string().trim().min(1).max(512) });
const evalQuerySchema = z.object({ gold: z.coerce.number().int().min(1).max(200).default(40) });

const TEMPLATES = {
  lexical: (label: string) => `What is ${label}?`,
  paraphrase: (label: string) =>
    `I'm revising for my exam and need a clear explanation of ${label} — walk me through how it works and why it matters.`,
} as const;
type TemplateName = keyof typeof TEMPLATES;
const ARMS = ['grep', 'graphify', 'hybrid'] as const;
type ArmName = (typeof ARMS)[number];

interface ArmStat {
  hits: number;
  total: number;
  latencyMs: number;
}

interface GoldNode {
  label: string;
  goldRelPath: string;
}

interface GraphNodeLike {
  label?: unknown;
  source_file?: unknown;
}

/** graph nodes whose source_file resolves to a real file under material/, in graph order, capped at n */
export function pickGoldNodes(
  graphJson: unknown,
  materialMap: Map<string, string>,
  n: number,
): GoldNode[] {
  const nodes = ((graphJson as { nodes?: GraphNodeLike[] }).nodes ?? []) as GraphNodeLike[];
  const out: GoldNode[] = [];
  for (const node of nodes) {
    if (typeof node.label !== 'string' || typeof node.source_file !== 'string') continue;
    const relPath = materialMap.get(node.source_file.toLowerCase());
    if (!relPath) continue;
    out.push({ label: node.label, goldRelPath: relPath });
    if (out.length >= n) break;
  }
  return out;
}

/** gold relPaths present in the first `topN` graphify hits (NODE lines carry src=<file>); null when unparseable */
function graphifyHitFiles(stdout: string, materialMap: Map<string, string>, topN: number): string[] | null {
  const files: string[] = [];
  for (const m of stdout.matchAll(/^NODE .+?\[src=([^\]\s]+)/gm)) {
    const rel = materialMap.get(m[1].toLowerCase());
    if (rel && !files.includes(rel)) files.push(rel);
    if (files.length >= topN) break;
  }
  return files.length > 0 ? files : null;
}

/** graphify BFS arm: query the subject's graph; falls back to a raw stdout substring check */
async function graphifyFiles(
  subjectPath: string,
  query: string,
  goldRelPath: string,
  materialMap: Map<string, string>,
): Promise<{ hit: boolean; timedOut: boolean; error?: string }> {
  const graph = path.join(subjectPath, 'graphify-out', 'graph.json');
  if (!existsSync(graph)) return { hit: false, timedOut: false, error: 'no graph.json' };
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn('graphify', ['query', query, '--graph', graph, '--json'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('graphify timeout (30s)'));
      }, 30_000);
      child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')));
      child.stderr?.on('data', () => undefined);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });
    const top5 = graphifyHitFiles(stdout, materialMap, 5);
    if (top5) return { hit: top5.includes(goldRelPath), timedOut: false };
    // fallback per spec: unreliable parse → a hit when the gold file path appears in stdout
    const goldBasename = path.basename(goldRelPath);
    return { hit: stdout.toLowerCase().includes(goldBasename.toLowerCase()), timedOut: false };
  } catch (e) {
    return { hit: false, timedOut: e instanceof Error && /timeout/.test(e.message), error: e instanceof Error ? e.message : String(e) };
  }
}

function record(
  stats: Record<ArmName, Record<TemplateName, ArmStat>>,
  arm: ArmName,
  template: TemplateName,
  hit: boolean,
  elapsedMs: number,
): void {
  const stat = stats[arm][template];
  stat.total++;
  stat.latencyMs += elapsedMs;
  if (hit) stat.hits++;
}

/** run every arm × template over the gold set (sequential — graphify spawns are the bottleneck) */
async function runEval(
  ctx: Ctx,
  subject: { id: string; path: string },
  gold: GoldNode[],
  materialMap: Map<string, string>,
): Promise<Record<ArmName, Record<TemplateName, ArmStat>>> {
  const stats = Object.fromEntries(
    ARMS.map((arm) => [
      arm,
      Object.fromEntries(
        (Object.keys(TEMPLATES) as TemplateName[]).map((t) => [t, { hits: 0, total: 0, latencyMs: 0 }]),
      ),
    ]),
  ) as Record<ArmName, Record<TemplateName, ArmStat>>;

  // hybrid arm needs a fresh index once, before the queries run
  await ensureIndex(ctx.db, subject, { log: (m) => console.log(`[retrieval-eval] ${m}`) });

  for (const node of gold) {
    for (const [template, make] of Object.entries(TEMPLATES) as [TemplateName, (l: string) => string][]) {
      const query = make(node.label);

      let t0 = Date.now();
      const grepHits = await grepSearch(subject.path, query, { k: 5 });
      record(stats, 'grep', template, grepHits.some((h) => h.relPath === node.goldRelPath), Date.now() - t0);

      t0 = Date.now();
      const g = await graphifyFiles(subject.path, query, node.goldRelPath, materialMap);
      record(stats, 'graphify', template, g.hit, Date.now() - t0);

      t0 = Date.now();
      const hybridHits = await hybridSearch(ctx.db, subject.id, query, { k: 5, subjectPath: subject.path });
      record(stats, 'hybrid', template, hybridHits.some((h) => h.relPath === node.goldRelPath), Date.now() - t0);
    }
  }
  return stats;
}

export async function registerSearchRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  app.get('/api/subjects/:id/search', async (req) => {
    const subject = requireSubject(ctx.db, (req.params as { id: string }).id);
    const { q } = parseWith(searchQuerySchema, req.query);
    await ensureIndex(ctx.db, subject, { log: (m) => req.log.info(m) });
    const hits = await hybridSearch(ctx.db, subject.id, q, {
      subjectPath: subject.path,
      log: (m) => req.log.warn(m),
    });
    return { hits };
  });

  // eval harness: arms × templates × hit@5 on graph-derived gold — scripted runs use scripts/retrieval-eval.mjs
  app.post('/api/subjects/:id/retrieval-eval', async (req) => {
    const subject = requireSubject(ctx.db, (req.params as { id: string }).id);
    const { gold } = parseWith(evalQuerySchema, req.query);
    const graphPath = path.join(subject.path, 'graphify-out', 'graph.json');
    if (!existsSync(graphPath)) {
      return { error: 'no graph.json for this subject — run the graph pipeline first' };
    }
    const materialMap = await materialFileMap(subject.path);
    const graphJson = JSON.parse(await readFile(graphPath, 'utf8')) as unknown;
    const goldNodes = pickGoldNodes(graphJson, materialMap, gold);
    const arms = await runEval(ctx, subject, goldNodes, materialMap);
    const round = (s: ArmStat) => ({
      hits: s.hits,
      total: s.total,
      hitAt5: s.total === 0 ? 0 : Number((s.hits / s.total).toFixed(3)),
      meanLatencyMs: s.total === 0 ? 0 : Math.round(s.latencyMs / s.total),
    });
    return {
      gold: { requested: gold, used: goldNodes.length, files: [...new Set(goldNodes.map((g) => g.goldRelPath))].sort() },
      arms: Object.fromEntries(
        Object.entries(arms).map(([arm, byTemplate]) => [
          arm,
          Object.fromEntries(Object.entries(byTemplate).map(([t, s]) => [t, round(s)])),
        ]),
      ),
    };
  });
}
