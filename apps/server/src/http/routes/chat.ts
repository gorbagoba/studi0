import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../context.js';
import { parseWith } from '../validate.js';
import { createSessionBodySchema, renameChatSessionBodySchema, sendMessageBodySchema } from '@studi0/shared';
import { requireSubject } from '../../subjects/service.js';
import * as chatRepo from '../../db/repos/chat.js';
import * as lessonsRepo from '../../db/repos/lessons.js';
import { sessionToDto, createOcSession, fetchHistory } from '../../teacher/sessions.js';
import { streamTurn } from '../../teacher/chatStream.js';
import { sseReply } from '../sse.js';
import { HttpError } from '../../util/errors.js';

export async function registerChatRoutes(app: FastifyInstance, ctx: Ctx): Promise<void> {
  const { db, oc, events, cfg } = ctx;
  // one turn per session at a time: two tabs double-pump the SSE stream and double-deposit
  const inFlight = new Set<string>();

  app.get('/api/subjects/:id/chat/sessions', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    return chatRepo.listSessions(db, subject.id).map(sessionToDto);
  });

  app.post('/api/subjects/:id/chat/sessions', async (req, reply) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const body = parseWith(createSessionBodySchema, req.body ?? {});
    let lessonId: string | null = null;
    if (body.lessonId) {
      if (!lessonsRepo.getLesson(db, body.lessonId)) {
        throw new HttpError('FILE_NOT_FOUND', `lesson ${body.lessonId} not found`);
      }
      lessonId = body.lessonId;
    }
    // fail here, not mid-message (contract): session is created eagerly
    oc.ensureUp();
    let ocId: string;
    try {
      ocId = await createOcSession(oc.client(), subject);
    } catch (e) {
      throw new HttpError('OPENCODE_DOWN', `failed to create opencode session: ${String(e)}`);
    }
    const row = chatRepo.insertSession(db, subject.id, ocId, lessonId);
    return reply.code(201).send(sessionToDto(row));
  });

  app.get('/api/chat/sessions/:id/messages', async (req) => {
    const session = chatRepo.getSession(db, (req.params as { id: string }).id);
    if (!session) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    // native-engine sessions keep their transcript locally; opencode ones in opencode
    const local = chatRepo.listMessages(db, session.id);
    if (local.length > 0) return local;
    oc.ensureUp();
    return fetchHistory(oc.client(), session.oc_session_id);
  });

  app.patch('/api/chat/sessions/:id', async (req) => {
    const session = chatRepo.getSession(db, (req.params as { id: string }).id);
    if (!session) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    const body = parseWith(renameChatSessionBodySchema, req.body);
    chatRepo.renameSession(db, session.id, body.title.trim());
    const fresh = chatRepo.getSession(db, session.id);
    if (!fresh) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    return sessionToDto(fresh);
  });

  app.delete('/api/chat/sessions/:id', async (req) => {
    const session = chatRepo.getSession(db, (req.params as { id: string }).id);
    if (!session) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    if (inFlight.has(session.id)) {
      throw new HttpError('TURN_IN_PROGRESS', 'a turn is running for this session — wait for it or cancel');
    }
    chatRepo.deleteSession(db, session.id);
    return { ok: true };
  });

  // remove the zero-message shells (eager creations that never got a turn)
  app.post('/api/subjects/:id/chat/sessions/clean', async (req) => {
    const subject = requireSubject(db, (req.params as { id: string }).id);
    const removable = chatRepo.listSessions(db, subject.id).filter((s) => s.msg_count === 0);
    for (const s of removable) {
      if (!inFlight.has(s.id)) chatRepo.deleteSession(db, s.id);
    }
    return { removed: removable.length };
  });

  app.post('/api/chat/sessions/:id/messages', async (req, reply) => {
    const session = chatRepo.getSession(db, (req.params as { id: string }).id);
    if (!session) throw new HttpError('SESSION_NOT_FOUND', 'session not found');
    const subject = requireSubject(db, session.subject_id);
    const body = parseWith(sendMessageBodySchema, req.body);
    if (body.lessonId && !lessonsRepo.getLesson(db, body.lessonId)) {
      throw new HttpError('FILE_NOT_FOUND', `lesson ${body.lessonId} not found`);
    }
    oc.ensureUp(); // pre-stream errors stay JSON
    if (inFlight.has(session.id)) {
      throw new HttpError('TURN_IN_PROGRESS', 'a turn is already running for this session');
    }
    inFlight.add(session.id);
    const send = sseReply(reply, cfg);
    try {
      await streamTurn(
        { db, cfg, events, client: oc.client(), oneshot: ctx.oneshot, feedQuestions: ctx.feedQuestions },
        subject,
        session,
        body.content,
        body.lessonId ?? null,
        send,
      );
    } finally {
      inFlight.delete(session.id);
      // the chat stream is always terminated by exactly one terminal event
      reply.raw.end();
    }
  });
}
