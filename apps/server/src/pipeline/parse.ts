/**
 * Parsing for pipeline stdout protocol lines and oneshot JSON answers.
 * All parsers are line-oriented and tolerate garbage — the model's prose
 * around protocol lines is ignored, never trusted.
 */

export interface ProgressLine {
  done: number;
  total: number;
  file: string | null;
}

export interface FailureLine {
  file: string;
  reason: string;
}

function jsonObjectsOnLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/\{.*\}/);
    if (!m) continue;
    try {
      out.push(JSON.parse(m[0]));
    } catch {
      // not JSON — ignore, protocol lines are opt-in
    }
  }
  return out;
}

export function parseProgress(stdout: string): ProgressLine | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('studi0-progress')) continue;
    for (const obj of jsonObjectsOnLines(line)) {
      const o = obj as Record<string, unknown>;
      if (typeof o.done === 'number' && typeof o.total === 'number') {
        return {
          done: o.done,
          total: o.total,
          file: typeof o.file === 'string' ? o.file : null,
        };
      }
    }
  }
  return null;
}

export function parseFailures(stdout: string): FailureLine[] {
  const failures: FailureLine[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes('studi0-failed')) continue;
    for (const obj of jsonObjectsOnLines(line)) {
      const o = obj as Record<string, unknown>;
      if (typeof o.file === 'string') {
        failures.push({ file: o.file, reason: typeof o.reason === 'string' ? o.reason : 'unknown' });
      }
    }
  }
  return failures;
}

/**
 * Extract a JSON answer from oneshot output: prefers the last fenced ```json
 * block, falls back to the last line that parses as a JSON object/array.
 * Returns null when nothing parseable is present.
 */
export function extractJson(stdout: string): unknown | null {
  const fenced = [...stdout.matchAll(/```(?:json)?\s*\r?\n([\s\S]*?)```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(fenced[i][1].trim());
    } catch {
      // keep looking
    }
  }
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith('{') || l.trim().startsWith('['));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i].trim());
    } catch {
      // keep looking
    }
  }
  return null;
}
