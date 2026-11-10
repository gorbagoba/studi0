// types for scripts/setup.mjs — the pure helpers its tests import
export const PORT_KEYS: Record<string, string>;
export const PORT_DEFAULTS: Record<string, number>;
export const PIP_PINS: { pkg: string; spec: string; want: (v: string) => boolean }[];
export const SKILL_AGENT_BY_CLI: Record<string, string>;
export const GRAPH_DEFAULT_MODEL: string;
export function maskSecret(s?: string | null): string;
export function graphEnvChanges(
  choice: number,
  entered?: { baseUrl?: string; apiKey?: string; model?: string },
  env?: Record<string, string | undefined>,
): Record<string, string>;
export function autoGraphChanges(env?: Record<string, string | undefined>): Record<string, string>;
export function pickDefaultHarness(have: { opencode?: boolean; claude?: boolean; codex?: boolean }): 'opencode' | 'claude' | 'codex' | null;
export function resolveOpencodeFromLines(
  lines: string[],
  exists?: (p: string) => boolean,
): { ok: boolean; exe: string | null; label: string; cmd?: string | null };
export function findOpencodeExeCandidates(
  whereLines: string[],
  opts?: { exists?: (p: string) => boolean; localAppData?: string; walk?: (dir: string) => string[] },
): string[];
export function walkForExe(dir: string, opts?: { maxDepth?: number; maxVisited?: number; maxHits?: number }): string[];
export function uvInstallArgs(pythonBin: string, specs: string[]): string[];
export function portBusy(port: number): Promise<boolean>;
export function pickFreePort(
  start: number,
  busy?: (port: number) => Promise<boolean>,
): Promise<number>;
export function parseEnvFile(text: string): Record<string, string>;
export function writeEnvFile(
  changes: Record<string, string | number>,
  opts?: {
    exists?: boolean;
    read?: (p: string) => string;
    write?: (p: string, t: string) => void;
  },
): void;
