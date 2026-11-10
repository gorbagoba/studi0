import { randomUUID } from 'node:crypto';

export interface Activity {
  id: string;
  subjectId: string;
  subjectName: string;
  kind: 'chat' | 'lesson-generation';
  startedAt: string;
}

/** In-flight teacher work (chat turns, lesson generation) for /api/agent/status. */
const active = new Map<string, Activity>();

/** No persistence: a restart forgets in-flight turns, same as setupRun. */
export function beginActivity(
  subjectId: string,
  subjectName: string,
  kind: Activity['kind'],
): string {
  const id = randomUUID();
  active.set(id, { id, subjectId, subjectName, kind, startedAt: new Date().toISOString() });
  return id;
}

export function endActivity(id: string): void {
  active.delete(id);
}

export function activeActivities(): Activity[] {
  return [...active.values()];
}
