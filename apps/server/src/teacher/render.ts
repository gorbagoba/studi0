import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { safeResolve } from '../fs/paths.js';

const execFileP = promisify(execFile);
const RENDER_TIMEOUT_MS = 20_000;

/** First existing candidate wins; PATH names are resolved by the OS. */
const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'google-chrome',
  'chromium',
  'chromium-browser',
];

/** One browser invocation; throws on spawn failure or nonzero exit. */
export type BrowserRun = (bin: string, args: string[]) => Promise<void>;

export interface RenderOpts {
  width?: number;
  height?: number;
  /** usually cfg.browserBin (STUDI0_BROWSER_BIN) */
  browserBin?: string | null;
  /** test seam: replaces the real spawn + 20s timeout */
  run?: BrowserRun;
}

async function defaultRun(bin: string, args: string[]): Promise<void> {
  await execFileP(bin, args, { timeout: RENDER_TIMEOUT_MS, windowsHide: true });
}

/**
 * Screenshot a lesson page to PNG with an installed headless browser.
 * Never throws: any failure (no browser, nonzero exit, no screenshot) → null.
 */
export async function renderLessonPng(
  subjectPath: string,
  relPath: string,
  opts: RenderOpts = {},
): Promise<Buffer | null> {
  let abs: string;
  try {
    abs = safeResolve(subjectPath, relPath); // traversal → PATH_TRAVERSAL, caught below
  } catch {
    return null;
  }
  const width = opts.width ?? 1100;
  const height = opts.height ?? 2400;
  const run = opts.run ?? defaultRun;
  const explicit = opts.browserBin ?? process.env.STUDI0_BROWSER_BIN;
  const bins = explicit ? [explicit, ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES;

  let dir: string;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'studi0-render-'));
  } catch {
    return null;
  }
  const png = path.join(dir, 'lesson.png');
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-sandbox',
    `--user-data-dir=${path.join(dir, 'profile')}`,
    `--window-size=${width},${height}`,
    `--screenshot=${png}`,
    pathToFileURL(abs).href,
  ];
  try {
    for (const bin of bins) {
      try {
        await run(bin, args);
      } catch {
        continue; // ENOENT / nonzero exit — try the next candidate
      }
      const buf = await readFile(png).catch(() => null);
      if (buf?.length) return buf;
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}
