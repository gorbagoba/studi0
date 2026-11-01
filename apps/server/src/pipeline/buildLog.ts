import { appendFile } from 'node:fs/promises';
import path from 'node:path';

export function buildLogPath(subjectRoot: string): string {
  return path.join(subjectRoot, 'graphify-out', 'build.log');
}

/** One build.log line, formatted. Shared by the file writer and the SSE `log` event so both match. */
export function formatLogLine(relSeconds: number, message: string): string {
  return `[T+${Math.round(relSeconds)}s] ${message}`;
}

/** Append one timestamped line to the subject's build log. Best-effort — never fails a build. */
export async function appendBuildLog(subjectRoot: string, relSeconds: number, message: string): Promise<void> {
  try {
    await appendFile(buildLogPath(subjectRoot), `${formatLogLine(relSeconds, message)}\n`);
  } catch {
    // logging must never break a pipeline run
  }
}
