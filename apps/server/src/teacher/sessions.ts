import path from 'node:path';
import * as chatRepo from '../db/repos/chat.js';
import type { ChatSessionRow } from '../db/repos/chat.js';
import type { SubjectRow } from '../db/repos/subjects.js';
import type { Db } from '../db/index.js';
import type { OcClient } from './sdk.js';
import type { OneshotFn } from '../util/oneshot.js';
import { rotationPrompt } from '../graph/prompts.js';
import { safeWriteFile } from '../fs/safeWrite.js';
import type { ChatMessage, ChatSession } from '@studi0/shared';
import { HttpError } from '../util/errors.js';
import { stripStepMarkers } from '../pipeline/parse.js';

export function sessionToDto(row: ChatSessionRow): ChatSession {
  return chatRepo.sessionToDto(row);
}

export async function createOcSession(
  client: OcClient,
  subject: SubjectRow,
): Promise<string> {
  const info = await client.session.create({
    agent: 'studi0-teacher',
    location: { directory: subject.path },
  });
  return info.id;
}

/** Proxy opencode messages into contract ChatMessage[]; throws SESSION_GONE. */
export async function fetchHistory(
  client: OcClient,
  ocSessionId: string,
): Promise<ChatMessage[]> {
  let res;
  try {
    res = await client.message.list({ sessionID: ocSessionId, order: 'asc' });
  } catch (e) {
    const tag = (e as { _tag?: string })._tag ?? '';
    if (tag.includes('SessionNotFound') || String(e).includes('SessionNotFound')) {
      throw new HttpError('SESSION_GONE', 'opencode no longer has this session');
    }
    throw new HttpError('OPENCODE_DOWN', `failed to read history: ${String(e)}`);
  }
  const out: ChatMessage[] = [];
  for (const m of res.data) {
    if (m.type === 'user') {
      out.push({
        id: m.id,
        role: 'user',
        text: m.text,
        createdAt: new Date(m.time.created).toISOString(),
      });
    } else if (m.type === 'assistant') {
      const text = stripStepMarkers(
        m.content
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n\n'),
      );
      if (text) {
        out.push({
          id: m.id,
          role: 'assistant',
          text,
          createdAt: new Date(m.time.created).toISOString(),
        });
      }
    }
  }
  return out;
}

export interface RotationResult {
  session: ChatSessionRow;
  rotated: boolean;
  summaryPath?: string;
}

/**
 * Rotate when the session exceeds the message or byte threshold: summarize via
 * one-shot run into learning-records/, mark old inactive, start a fresh one.
 * `getHistory` lets the native engine read its local transcript instead of opencode's.
 */
export async function maybeRotate(
  client: OcClient,
  oneshot: OneshotFn,
  db: Db,
  subject: SubjectRow,
  session: ChatSessionRow,
  getHistory: (ocSessionId: string) => Promise<ChatMessage[]> = (id) => fetchHistory(client, id),
): Promise<RotationResult> {
  const history = await getHistory(session.oc_session_id);
  const bytes = history.reduce((n, m) => n + m.text.length, 0);
  if (session.msg_count < 24 && bytes <= 60_000) {
    return { session, rotated: false };
  }
  const transcript = history
    .map((m) => `${m.role === 'user' ? 'Student' : 'Teacher'}: ${m.text}`)
    .join('\n\n')
    .slice(-80_000);
  const summary = await oneshot(subject.path, rotationPrompt(transcript));
  const date = new Date().toISOString().slice(0, 10);
  const slug = subject.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';
  const fileName = `${date}-${slug}-${session.id.slice(0, 8)}.md`;
  const summaryRel = `learning-records/${fileName}`;
  await safeWriteFile(path.join(subject.path, 'learning-records', fileName), summary.trim() + '\n');

  chatRepo.rotateSession(db, session.id, summaryRel);
  const ocId = await createOcSession(client, subject);
  const fresh = chatRepo.insertSession(db, subject.id, ocId, session.lesson_id);
  return { session: fresh, rotated: true, summaryPath: summaryRel };
}
