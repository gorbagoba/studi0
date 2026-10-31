import { existsSync, statSync, readdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import * as subjectsRepo from '../db/repos/subjects.js';
import * as jobsRepo from '../db/repos/jobs.js';
import * as lessonsRepo from '../db/repos/lessons.js';
import * as questionsRepo from '../db/repos/questions.js';
import * as filesRepo from '../db/repos/files.js';
import { countDue } from '../db/repos/schedule.js';
import { ensureLayout, syncTeacherAgent, seedFileRows } from '../fs/layout.js';
import type { Config } from '../config.js';
import { HttpError } from '../util/errors.js';
import type { Subject, SubjectDetail, GraphStatus } from '@studi0/shared';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { JobRow } from '../db/repos/jobs.js';

const NAME_RE = /^[^<>:"/\\|?*\p{Cc}]{1,120}$/u;

export function subjectToDto(row: SubjectRow, stale: boolean): Subject {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    lastBuiltAt: row.last_built_at,
    stale,
  };
}

/** stale = any material/** mtime after last_built_at (computed, never stored). */
export async function computeStale(row: SubjectRow): Promise<boolean> {
  if (!row.last_built_at) return false;
  const maxMtime = await maxMaterialMtime(row.path);
  return maxMtime !== null && maxMtime > row.last_built_at;
}

export async function graphStatusFor(
  row: SubjectRow,
  activeJob: JobRow | null,
): Promise<GraphStatus> {
  if (activeJob) return 'building';
  if (!existsSync(path.join(row.path, 'graphify-out', 'graph.json'))) return 'none';
  return (await computeStale(row)) ? 'stale' : 'ready';
}

export function requireSubject(db: Db, id: string): SubjectRow {
  const row = subjectsRepo.getSubject(db, id);
  if (!row) throw new HttpError('SUBJECT_NOT_FOUND', `subject ${id} not found`);
  return row;
}

export async function subjectDetail(db: Db, row: SubjectRow): Promise<SubjectDetail> {
  const activeJob = jobsRepo.activeJobForSubject(db, row.id);
  const stale = await computeStale(row);
  const now = new Date().toISOString();
  return {
    ...subjectToDto(row, stale),
    graphStatus: await graphStatusFor(row, activeJob),
    activeJob: activeJob ? jobsRepo.jobToDto(activeJob) : null,
    counts: {
      lessons: lessonsRepo.listLessons(db, row.id).length,
      questions: questionsRepo.listQuestions(db, row.id, {}).length,
      due: countDue(db, row.id, now),
    },
  };
}

export async function registerSubject(
  cfg: Config,
  db: Db,
  body: { name: string; path?: string },
): Promise<SubjectRow> {
  if (!NAME_RE.test(body.name)) {
    throw new HttpError('VALIDATION', `invalid subject name: ${body.name}`);
  }
  if (subjectsRepo.getSubjectByName(db, body.name)) {
    throw new HttpError('NAME_TAKEN', `a subject named "${body.name}" already exists`);
  }

  let root: string;
  if (body.path) {
    // register an existing folder in place — never copy or move anything
    if (!existsSync(body.path) || !statSync(body.path).isDirectory()) {
      throw new HttpError('PATH_NOT_FOUND', `folder not found: ${body.path}`);
    }
    root = await realpath(body.path);
  } else {
    root = path.join(cfg.subjectsDir, body.name);
    if (existsSync(root)) {
      if (!statSync(root).isDirectory() || readdirSync(root).length > 0) {
        throw new HttpError('NAME_TAKEN', `folder already exists and is not empty: ${root}`);
      }
    }
  }

  if (subjectsRepo.getSubjectByPath(db, root)) {
    throw new HttpError('NAME_TAKEN', 'this folder is already registered as a subject');
  }

  await ensureLayout(root);
  await syncTeacherAgent(root);
  const row = subjectsRepo.insertSubject(db, {
    id: randomUUID(),
    name: body.name,
    path: root,
    created_at: new Date().toISOString(),
  });
  // mirror existing material/ inventory (provenance + staleness fast path)
  await seedFileRows(root, (relPath, bytes, mtime) =>
    filesRepo.upsertFile(db, { subject_id: row.id, rel_path: relPath, bytes, mtime, origin: 'seed' }),
  );
  return row;
}

export async function listSubjectDtos(db: Db): Promise<Subject[]> {
  const rows = subjectsRepo.listSubjects(db);
  return Promise.all(rows.map(async (row) => subjectToDto(row, await computeStale(row))));
}

async function maxMaterialMtime(subjectRoot: string): Promise<string | null> {
  const materialDir = path.join(subjectRoot, 'material');
  if (!existsSync(materialDir)) return null;
  let max: string | null = null;
  await walk(materialDir, (abs) => {
    const mtime = statSync(abs).mtime.toISOString();
    if (max === null || mtime > max) max = mtime;
  });
  return max;
}

async function walk(dir: string, on: (abs: string) => void): Promise<void> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(abs, on);
    else if (entry.isFile()) on(abs);
  }
}
