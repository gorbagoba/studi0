import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { CourseSetupBody } from '@studi0/shared';
import { safeWriteFile } from '../fs/safeWrite.js';

export const SETUP_BEGIN = '<!-- studi0:form-setup v1 -->';
const SETUP_END = '<!-- end studi0:form-setup -->';

/** Render the form answers as MISSION.md bullet lines — blanks are omitted entirely. */
export function renderSetupSection(body: CourseSetupBody): string {
  const line = (label: string, value: string) =>
    value.trim() ? `- **${label}:** ${value.trim().replace(/\r?\n/g, ' · ')}` : null;
  const bullets = [
    line('Course / exam', body.courseIdentity),
    line('Exam date', body.examDate),
    line(
      'Confidence',
      {
        lost: 'Lost — start from the basics',
        shaky: 'Shaky — knows some of it',
        okay: 'Okay — needs exam polish',
        solid: 'Solid — targeted practice only',
        '': '',
      }[body.confidence] ?? '',
    ),
    line('Weak topics', body.weakTopics),
    line('Weekly hours', body.hoursPerWeek),
    line(
      'Learning style',
      { 'examples-first': 'examples first', 'theory-first': 'theory first', mixed: 'mixed', '': '' }[
        body.learningStyle
      ] ?? '',
    ),
    line('Things the teacher must know', body.notesToTeacher),
  ].filter((l) => l !== null);
  const inner = bullets.length ? '\n' + bullets.join('\n') + '\n' : '\n(no answers given — run the onboarding interview)\n';
  return `## Student setup (from form)\n${SETUP_BEGIN}${inner}${SETUP_END}\n`;
}

/** Replace any existing form-setup block in a MISSION.md, or append the section. */
export function upsertSetupSection(mission: string | null, section: string): string {
  if (mission === null || mission.trim() === '') {
    return `# MISSION\n\n${section}`;
  }
  const begin = mission.indexOf(SETUP_BEGIN);
  if (begin >= 0) {
    const end = mission.indexOf(SETUP_END, begin);
    if (end >= 0) {
      // keep everything before the section heading line, splice the new block in
      const before = mission.slice(0, mission.lastIndexOf('## Student setup', begin));
      return before + section + mission.slice(end + SETUP_END.length).replace(/^\r?\n/, '\n');
    }
  }
  return mission.replace(/\s*$/, '\n\n') + section;
}

/** Read MISSION.md (null if absent), upsert the form section, write back. Returns the final content. */
export async function applySetupToMission(subjectRoot: string, body: CourseSetupBody): Promise<string> {
  const abs = path.join(subjectRoot, 'MISSION.md');
  const current = existsSync(abs) ? await readFile(abs, 'utf8') : null;
  const next = upsertSetupSection(current, renderSetupSection(body));
  await safeWriteFile(abs, next);
  return next;
}
