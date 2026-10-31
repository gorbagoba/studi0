import type {
  AnswerResponse,
  ApiErrorPayload,
  ChatMessage,
  ChatSession,
  CreateSessionRequest,
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

function send<T>(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
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

export const getSubject = (id: ID): Promise<SubjectDetail> =>
  api<SubjectDetail>(`/api/subjects/${id}`);

// ---- files ----

export const getTree = (id: ID, dir: TreeDir | null): Promise<TreeResponse> =>
  api<TreeResponse>(`/api/subjects/${id}/tree${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`);

export const uploadFiles = (id: ID, form: FormData): Promise<UploadResult> =>
  api<UploadResult>(`/api/subjects/${id}/files`, { method: 'POST', body: form });

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

// ---- chat ----

export const getSessions = (id: ID): Promise<ChatSession[]> =>
  api<ChatSession[]>(`/api/subjects/${id}/chat/sessions`);

export const createSession = (id: ID, body: CreateSessionRequest): Promise<ChatSession> =>
  send<ChatSession>('POST', `/api/subjects/${id}/chat/sessions`, body);

export const getMessages = (sessionId: ID): Promise<ChatMessage[]> =>
  api<ChatMessage[]>(`/api/chat/sessions/${sessionId}/messages`);

// ---- practice ----

export function getQuestions(
  id: ID,
  topic: string,
  type: '' | QuestionType,
): Promise<Question[]> {
  const params = new URLSearchParams();
  if (topic !== '') params.set('topic', topic);
  if (type !== '') params.set('type', type);
  const qs = params.toString();
  return api<Question[]>(`/api/subjects/${id}/questions${qs === '' ? '' : `?${qs}`}`);
}

export const generateQuestions = (
  id: ID,
  body: GenerateQuestionsRequest,
): Promise<Question[]> =>
  send<Question[]>('POST', `/api/subjects/${id}/questions/generate`, body);

export const answerQuestion = (questionId: ID, answer: string): Promise<AnswerResponse> =>
  send<AnswerResponse>('POST', `/api/questions/${questionId}/answer`, { answer });

export const verifyKey = (questionId: ID): Promise<VerifyKeyResponse> =>
  send<VerifyKeyResponse>('POST', `/api/questions/${questionId}/verify-key`);

export const revealKey = (questionId: ID): Promise<RevealKeyResponse> =>
  send<RevealKeyResponse>('POST', `/api/questions/${questionId}/reveal-key`);

export const getDue = (id: ID): Promise<DueResponse> =>
  api<DueResponse>(`/api/subjects/${id}/practice/due`);

export const getStats = (id: ID): Promise<Stats> =>
  api<Stats>(`/api/subjects/${id}/practice/stats`);
