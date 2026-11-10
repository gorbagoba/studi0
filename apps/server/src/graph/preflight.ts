import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export type GraphifyProbe = (
  bin: string,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

export type GraphifyCheck = { ok: true; version: string } | { ok: false; error: string };

const SETUP_HINT = 'run `pnpm setup` to create .graphify-venv';

/** No shell; a hung wrapper must not stall job start. */
export const probeGraphify: GraphifyProbe = (bin) =>
  new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Fail fast with one actionable line instead of letting an agent flail for the venv. */
export async function checkGraphify(
  bin: string,
  probe: GraphifyProbe = probeGraphify,
): Promise<GraphifyCheck> {
  if (!existsSync(bin)) {
    return { ok: false, error: `graphify venv missing: ${SETUP_HINT} (${bin} not found)` };
  }
  const res = await probe(bin);
  if (res.code !== 0) {
    return { ok: false, error: `graphify venv broken: ${SETUP_HINT} (${bin} --version failed)` };
  }
  const version =
    (res.stdout || res.stderr)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? 'unknown';
  return { ok: true, version: version.slice(0, 120) };
}
