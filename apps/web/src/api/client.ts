import type {
  AnswerResponse,
  ApiErrorPayload,
  ChatMessage,
  ChatSession,
  CourseSetupBody,
  CreateSessionRequest,
  FileRow,
  Group,
  Health,
  LessonReviewResponse,
  LessonReviewSubmit,
  MergeResponse,
  OpencodeHealth,
  DueResponse,
  ErrorCode,
  GenerateQuestionsRequest,
  GraphInfo,
  GraphReport,
  ID,
  Job,
  JobKind,
  Lesson,
  LessonContent,
  Question,
  QuestionType,
  RevealKeyResponse,
  Stats,
  Subject,
  SubjectDetail,
  TreeDir,
  TreeResponse,
  UploadResult,
  VerifyKeyResponse,
  WikiPage,
  WikiPageSaved,
} from '@studi0/shared';

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function displayError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function toApiError(res: Response): Promise<ApiError> {
  let code: ErrorCode = 'INTERNAL';
  let message = `Request failed (${res.status})`;
  let details: unknown;
  try {
    const body = (await res.json()) as ApiErrorPayload;
    if (body && typeof body === 'object' && 'error' in body) {
      code = body.error.code;
      message = body.error.message;
      details = body.error.details;
    }
  } catch {
    // non-JSON error body — keep the status-based defaults
  }
  return new ApiError(code, message, res.status, details);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function send<T>(
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  return api<T>(path, {
    method,
    // bodyless POSTs must not carry a JSON content-type — Fastify rejects empty JSON bodies
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---- subjects ----

export const getSubjects = (): Promise<Subject[]> => api<Subject[]>('/api/subjects');

export const createSubject = (body: { name: string; path?: string }): Promise<SubjectDetail> =>
  send<SubjectDetail>('POST', '/api/subjects', body);

// unregister only — the subject's files on disk are never touched
export const deleteSubject = (id: ID): Promise<void> => send<void>('DELETE', `/api/subjects/${id}`);

// PATCH takes {name?, groupId?}; groupId null = ungroup. The 409 JOB_CONFLICT refusal surfaces via ApiError.
export const renameSubject = (
  id: ID,
  patch: { name?: string; groupId?: string | null; icon?: string | null },
): Promise<Subject> => send('PATCH', `/api/subjects/${id}`, patch);

export const mergeSubject = (id: ID, targetId: ID): Promise<MergeResponse> =>
  send('POST', `/api/subjects/${id}/merge-into`, { targetId });

/** Irreversible — deletes the subject's folder on disk; refused with 409 JOB_CONFLICT while a job runs. */
export const deleteSubjectFiles = (id: ID, body: { confirm: string }): Promise<{ ok: boolean }> =>
  send('POST', `/api/subjects/${id}/delete-files`, body);

// ---- groups ----

export const getGroups = (): Promise<Group[]> => api<Group[]>('/api/groups');

export const createGroup = (name: string): Promise<Group> =>
  send('POST', '/api/groups', { name });

export const renameGroup = (id: ID, name: string): Promise<Group> =>
  send('PATCH', `/api/groups/${id}`, { name });

/** Deleting never deletes subjects — they become ungrouped. */
export const deleteGroup = (id: ID): Promise<{ ok: boolean }> =>
  send('DELETE', `/api/groups/${id}`);

export const getBuildLog = (id: ID): Promise<{ log: string | null }> =>
  api<{ log: string | null }>(`/api/subjects/${id}/graph/log`);

export const setupCourse = (
  id: ID,
  body: CourseSetupBody,
): Promise<{ ok: boolean; generating?: boolean }> =>
  send<{ ok: boolean; generating?: boolean }>('POST', `/api/subjects/${id}/setup`, body);

export const shutdownServer = (): Promise<{ ok: boolean }> =>
  send<{ ok: boolean }>('POST', '/api/shutdown');

export const getHealth = (): Promise<Health> => api<Health>('/api/health');

/** Best-effort agent overview; optional fields may be absent while the backend lands. */
export interface AgentStatus {
  busy: boolean;
  task: { kind: string; subjectId: string; subjectName: string; startedAt: string } | null;
  /** Graph jobs carry `subject`/`status`/`done`/`total`; activity rows carry `subjectName`/`startedAt`. */
  jobs: Array<{
    id: string;
    kind: string;
    subject?: string;
    status?: string;
    done?: number;
    total?: number;
    subjectName?: string;
    startedAt?: string;
  }>;
}

export const getAgentStatus = (): Promise<AgentStatus> => api<AgentStatus>('/api/agent/status');

export const restartTeacher = (): Promise<{ ok: boolean; opencode: OpencodeHealth }> =>
  send<{ ok: boolean; opencode: OpencodeHealth }>('POST', '/api/teacher/restart');

export const getSubject = (id: ID): Promise<SubjectDetail> =>
  api<SubjectDetail>(`/api/subjects/${id}`);

// ---- files ----

export const getTree = (id: ID, dir: TreeDir | null): Promise<TreeResponse> =>
  api<TreeResponse>(`/api/subjects/${id}/tree${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);

export const uploadFiles = (id: ID, form: FormData): Promise<UploadResult> =>
  api<UploadResult>(`/api/subjects/${id}/files`, { method: 'POST', body: form });

/** Splits a big PDF into `<stem>_pNN.pdf` parts next to the original; the original is kept. */
export const splitPdf = (id: ID, file: string): Promise<{ parts: string[] }> =>
  send<{ parts: string[] }>('POST', `/api/subjects/${id}/split-pdf`, { file });

// shortcut: rename/delete reuse informal RESTful shapes, no shared contract — formalize when the file API gets versioned
export const renameFile = (fileId: ID, name: string): Promise<FileRow> =>
  send('PATCH', `/api/files/${fileId}`, { name });

export const deleteFile = (fileId: ID): Promise<{ ok: boolean }> =>
  send('DELETE', `/api/files/${fileId}`);

/** 409 (NAME_TAKEN) when the target subject already has a file with this name. */
export const moveFile = (fileId: ID, targetSubjectId: ID): Promise<FileRow> =>
  send('POST', `/api/files/${fileId}/move`, { targetSubjectId });

// ---- jobs ----

export const startJob = (id: ID, kind: JobKind): Promise<Job> =>
  send<Job>('POST', `/api/subjects/${id}/jobs`, { kind });

export const cancelJob = (jobId: ID): Promise<Job> =>
  send<Job>('POST', `/api/jobs/${jobId}/cancel`);

// ---- graph / wiki ----

export const getGraph = (id: ID): Promise<GraphInfo> => api<GraphInfo>(`/api/subjects/${id}/graph`);

export const getReport = (id: ID): Promise<GraphReport> =>
  api<GraphReport>(`/api/subjects/${id}/graph/report`);

export const getWiki = (id: ID): Promise<{ pages: { name: string; updatedAt: string }[] }> =>
  api<{ pages: { name: string; updatedAt: string }[] }>(`/api/subjects/${id}/wiki`);

export const getWikiPage = (id: ID, name: string): Promise<WikiPage> =>
  api<WikiPage>(`/api/subjects/${id}/wiki/${encodeURIComponent(name)}`);

export const saveWikiPage = (id: ID, name: string, markdown: string): Promise<WikiPageSaved> =>
  send<WikiPageSaved>('PUT', `/api/subjects/${id}/wiki/${encodeURIComponent(name)}`, { markdown });

// ---- lessons ----

export const getLessons = (id: ID): Promise<Lesson[]> => api<Lesson[]>(`/api/subjects/${id}/lessons`);

export const getLessonContent = (id: ID, path: string): Promise<LessonContent> =>
  api<LessonContent>(`/api/subjects/${id}/lessons/content?path=${encodeURIComponent(path)}`);

export const renameLesson = (id: ID, title: string): Promise<Lesson> =>
  send('PATCH', `/api/lessons/${id}`, { title });

// also deletes the lesson's questions, attempts and review schedule, and its HTML file; 404 for an unknown id
export const deleteLesson = (id: ID): Promise<{ ok: boolean }> =>
  send<{ ok: boolean }>('DELETE', `/api/lessons/${id}`);

// ---- chat ----

export const getSessions = (id: ID): Promise<ChatSession[]> =>
  api<ChatSession[]>(`/api/subjects/${id}/chat/sessions`);

export const createSession = (id: ID, body: CreateSessionRequest): Promise<ChatSession> =>
  send<ChatSession>('POST', `/api/subjects/${id}/chat/sessions`, body);

export const renameChatSession = (sessionId: ID, title: string): Promise<ChatSession> =>
  send<ChatSession>('PATCH', `/api/chat/sessions/${sessionId}`, { title });

export const deleteChatSession = (sessionId: ID): Promise<{ ok: boolean }> =>
  send('DELETE', `/api/chat/sessions/${sessionId}`);

export const cleanChatSessions = (id: ID): Promise<{ removed: number }> =>
  send('POST', `/api/subjects/${id}/chat/sessions/clean`, {});

export const getSetupStatus = (id: ID): Promise<{ done: boolean }> =>
  api<{ done: boolean }>(`/api/subjects/${id}/setup-status`);

export const getMessages = (sessionId: ID): Promise<ChatMessage[]> =>
  api<ChatMessage[]>(`/api/chat/sessions/${sessionId}/messages`);

// ---- practice ----

export function getQuestions(
  id: ID,
  topic: string,
  type: '' | QuestionType,
  lessonId?: ID,
): Promise<Question[]> {
  const params = new URLSearchParams();
  if (topic !== '') params.set('topic', topic);
  if (type !== '') params.set('type', type);
  if (lessonId) params.set('lessonId', lessonId);
  const qs = params.toString();
  return api<Question[]>(`/api/subjects/${id}/questions${qs === '' ? '' : `?${qs}`}`);
}

export const generateQuestions = (
  id: ID,
  body: GenerateQuestionsRequest,
): Promise<Question[]> =>
  send<Question[]>('POST', `/api/subjects/${id}/questions/generate`, body);

export const answerQuestion = (
  questionId: ID,
  answer: string,
  confidence?: 'high' | 'medium' | 'low',
): Promise<AnswerResponse> =>
  send<AnswerResponse>('POST', `/api/questions/${questionId}/answer`, confidence ? { answer, confidence } : { answer });

export const submitLessonReview = (
  lessonId: ID,
  answers: LessonReviewSubmit['answers'],
): Promise<LessonReviewResponse> =>
  send<LessonReviewResponse>('POST', `/api/lessons/${lessonId}/review`, { answers });

export const verifyKey = (questionId: ID): Promise<VerifyKeyResponse> =>
  send<VerifyKeyResponse>('POST', `/api/questions/${questionId}/verify-key`);

export const revealKey = (questionId: ID): Promise<RevealKeyResponse> =>
  send<RevealKeyResponse>('POST', `/api/questions/${questionId}/reveal-key`);

// also deletes the question's attempts and review schedule; 404 for an unknown id
export const deleteQuestion = (id: ID): Promise<{ ok: boolean }> =>
  send<{ ok: boolean }>('DELETE', `/api/questions/${id}`);

export const getDue = (id: ID): Promise<DueResponse> =>
  api<DueResponse>(`/api/subjects/${id}/practice/due`);

export const getStats = (id: ID): Promise<Stats> =>
  api<Stats>(`/api/subjects/${id}/practice/stats`);
