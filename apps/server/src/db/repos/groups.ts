import { randomUUID } from 'node:crypto';
import type { Db } from '../index.js';

export interface GroupRow {
  id: string;
  name: string;
  created_at: string;
}

export interface GroupRowWithCount extends GroupRow {
  subject_count: number;
}

const GROUP_SELECT =
  'SELECT g.*, (SELECT COUNT(*) FROM subjects s WHERE s.group_id = g.id) AS subject_count FROM groups g';

export function groupToDto(row: GroupRowWithCount): {
  id: string;
  name: string;
  subjectCount: number;
  createdAt: string;
} {
  return {
    id: row.id,
    name: row.name,
    subjectCount: row.subject_count,
    createdAt: row.created_at,
  };
}

export function insertGroup(db: Db, name: string): GroupRowWithCount {
  const id = randomUUID();
  const created_at = new Date().toISOString();
  db.prepare('INSERT INTO groups (id, name, created_at) VALUES (?, ?, ?)').run(id, name, created_at);
  return getGroup(db, id) as GroupRowWithCount;
}

export function getGroup(db: Db, id: string): GroupRowWithCount | null {
  return (db.prepare(`${GROUP_SELECT} WHERE g.id = ?`).get(id) ?? null) as unknown as GroupRowWithCount | null;
}

export function getGroupByName(db: Db, name: string): GroupRow | null {
  return (db.prepare('SELECT * FROM groups WHERE name = ?').get(name) ?? null) as unknown as GroupRow | null;
}

export function listGroups(db: Db): GroupRowWithCount[] {
  return db.prepare(`${GROUP_SELECT} ORDER BY g.created_at`).all() as unknown as GroupRowWithCount[];
}

export function renameGroup(db: Db, id: string, name: string): void {
  db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
}

/** Deleting a group never touches subjects — they just become ungrouped. */
export function deleteGroup(db: Db, id: string): void {
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE subjects SET group_id = NULL WHERE group_id = ?').run(id);
    db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
