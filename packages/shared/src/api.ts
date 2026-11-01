import { z } from 'zod';

export const idSchema = z.uuid();
export const isoSchema = z.iso.datetime();
export type ID = z.infer<typeof idSchema>;
export type ISO = z.infer<typeof isoSchema>;

// ---- enums ----

export const jobKindSchema = z.enum(['build', 'update', 'recluster']);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'cancelling',
  'complete',
  'partial',
  'failed',
  'cancelled',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const graphStatusSchema = z.enum(['none', 'ready', 'stale', 'building']);
export type GraphStatus = z.infer<typeof graphStatusSchema>;

export const treeDirSchema = z.enum(['material', 'lessons', 'reference', 'graphify-out']);
export type TreeDir = z.infer<typeof treeDirSchema>;

export const questionTypeSchema = z.enum(['mcq', 'short', 'code']);
export type QuestionType = z.infer<typeof questionTypeSchema>;

export const keyStatusSchema = z.enum(['unverified', 'verified', 'failed']);
export type KeyStatus = z.infer<typeof keyStatusSchema>;

// ---- resources ----

export const subjectSchema = z.object({
  id: idSchema,
  name: z.string(),
  path: z.string(),
  createdAt: isoSchema,
  lastBuiltAt: isoSchema.nullable(),
  stale: z.boolean(),
  groupId: idSchema.nullable(),
  groupName: z.string().nullable(),
  icon: z.string().nullable(),
});
export type Subject = z.infer<typeof subjectSchema>;

export const jobSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  kind: jobKindSchema,
  status: jobStatusSchema,
  progress: z.object({
    done: z.number().int(),
    total: z.number().int(),
    currentFile: z.string().nullable(),
  }),
  partial: z
    .array(z.object({ file: z.string(), reason: z.string() }))
    .nullable(),
  error: z.string().nullable(),
  createdAt: isoSchema,
  startedAt: isoSchema.nullable(),
  finishedAt: isoSchema.nullable(),
});
export type Job = z.infer<typeof jobSchema>;

export const subjectDetailSchema = subjectSchema.extend({
  graphStatus: graphStatusSchema,
  activeJob: jobSchema.nullable(),
  counts: z.object({
    lessons: z.number().int(),
    questions: z.number().int(),
    due: z.number().int(),
  }),
});
export type SubjectDetail = z.infer<typeof subjectDetailSchema>;

export const groupSchema = z.object({
  id: idSchema,
  name: z.string(),
  subjectCount: z.number().int(),
  createdAt: isoSchema,
});
export type Group = z.infer<typeof groupSchema>;

export const fileEntrySchema = z.object({
  /** files-table row id — present on registered files (material/), absent for bare dirs */
  id: z.string().optional(),
  path: z.string(),
  dir: z.string(),
  name: z.string(),
  ext: z.string(),
  bytes: z.number().int(),
  mtime: isoSchema,
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const renameFileBodySchema = z.object({ name: z.string().min(1).max(160) });
export type RenameFileRequest = z.infer<typeof renameFileBodySchema>;

/** A files-table row (used by the per-file move response). */
export const fileRowSchema = fileEntrySchema.extend({
  id: idSchema,
  subjectId: idSchema,
  origin: z.enum(['upload', 'seed']),
});
export type FileRow = z.infer<typeof fileRowSchema>;

export const treeResponseSchema = z.object({
  dir: z.string(),
  entries: z.array(fileEntrySchema),
});
export type TreeResponse = z.infer<typeof treeResponseSchema>;

export const uploadResultSchema = z.object({
  accepted: z.array(fileEntrySchema),
  rejected: z.array(z.object({ name: z.string(), reason: z.string() })),
});
export type UploadResult = z.infer<typeof uploadResultSchema>;

export const lessonSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  path: z.string(),
  title: z.string(),
  nodeTags: z.array(z.string()),
  createdAt: isoSchema,
  updatedAt: isoSchema,
});
export type Lesson = z.infer<typeof lessonSchema>;

export const lessonContentSchema = z.object({
  path: z.string(),
  title: z.string(),
  html: z.string(),
  nodeTags: z.array(z.string()),
  updatedAt: isoSchema,
});
export type LessonContent = z.infer<typeof lessonContentSchema>;

export const chatSessionSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  lessonId: idSchema.nullable(),
  active: z.boolean(),
  messageCount: z.number().int(),
  summaryPath: z.string().nullable(),
  createdAt: isoSchema,
  lastMessageAt: isoSchema.nullable(),
  title: z.string().nullable(),
});
export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatMessageSchema = z.object({
  id: idSchema,
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: isoSchema,
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const questionPayloadSchema = z.object({
  prompt: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).optional(),
  rubric: z.string().optional(),
});
export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

export const questionKeySchema = z.object({
  answerIndex: z.number().int().optional(),
  answer: z.string().optional(),
  rubric: z.string().optional(),
});
export type QuestionKey = z.infer<typeof questionKeySchema>;

export const questionSchema = z.object({
  id: idSchema,
  subjectId: idSchema,
  lessonId: idSchema.nullable(),
  topic: z.string(),
  type: questionTypeSchema,
  payload: questionPayloadSchema,
  keyStatus: keyStatusSchema,
  source: z.enum(['auto', 'on_demand']),
  createdAt: isoSchema,
});
export type Question = z.infer<typeof questionSchema>;

export const gradeSchema = z.object({
  verdict: z.enum(['correct', 'partial', 'incorrect']),
  feedback: z.string(),
});
export type Grade = z.infer<typeof gradeSchema>;

export const statsSchema = z.object({
  perTopic: z.array(
    z.object({
      topic: z.string(),
      attempts: z.number().int(),
      correct: z.number().int(),
      accuracy: z.number(),
    }),
  ),
  dueCount: z.number().int(),
  streakDays: z.number().int(),
  totalQuestions: z.number().int(),
});
export type Stats = z.infer<typeof statsSchema>;

// ---- health ----

export const opencodeHealthSchema = z.object({
  running: z.boolean(),
  pid: z.string().nullable(),
  port: z.number().int(),
  healthy: z.boolean(),
});
export type OpencodeHealth = z.infer<typeof opencodeHealthSchema>;

export const activeJobSchema = z.object({
  id: z.string(),
  subject: z.string(),
  kind: jobKindSchema,
  status: z.enum(['queued', 'running', 'cancelling']),
  done: z.number().int(),
  total: z.number().int(),
});
export type ActiveJob = z.infer<typeof activeJobSchema>;

// ---- endpoint request bodies ----

/** Course setup form — every field optional; blanks are omitted from MISSION.md. */
export const courseSetupBodySchema = z.object({
  courseIdentity: z.string().max(200).default(''),
  examDate: z.string().max(80).default(''),
  confidence: z.enum(['', 'lost', 'shaky', 'okay', 'solid']).default(''),
  weakTopics: z.string().max(1000).default(''),
  hoursPerWeek: z.string().max(30).default(''),
  learningStyle: z.enum(['', 'examples-first', 'theory-first', 'mixed']).default(''),
  notesToTeacher: z.string().max(3000).default(''),
});
export type CourseSetupBody = z.infer<typeof courseSetupBodySchema>;

export const createSubjectBodySchema = z.object({
  name: z.string().min(1).max(120),
  path: z.string().min(1).optional(),
});
export type CreateSubjectRequest = z.infer<typeof createSubjectBodySchema>;

export const renameSubjectBodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  groupId: idSchema.nullable().optional(),
  /** emoji glyph for the sidebar/rail; null removes it */
  icon: z.string().max(16).nullable().optional(),
});

/** Irreversible disk delete — the body must echo the exact subject name. */
export const deleteFilesBodySchema = z.object({ confirm: z.string().min(1) });
export type DeleteFilesRequest = z.infer<typeof deleteFilesBodySchema>;

export const renameChatSessionBodySchema = z.object({ title: z.string().min(1).max(80) });
export type RenameChatSessionRequest = z.infer<typeof renameChatSessionBodySchema>;

export const createGroupBodySchema = z.object({ name: z.string().min(1).max(120) });
export type CreateGroupRequest = z.infer<typeof createGroupBodySchema>;

export const renameGroupBodySchema = z.object({ name: z.string().min(1).max(120) });
export type RenameGroupRequest = z.infer<typeof renameGroupBodySchema>;

export const mergeBodySchema = z.object({ targetId: idSchema });
export type MergeRequest = z.infer<typeof mergeBodySchema>;

export const mergeResponseSchema = z.object({
  moved: z.array(z.string()),
  skipped: z.array(z.string()),
});
export type MergeResponse = z.infer<typeof mergeResponseSchema>;

export const moveFileBodySchema = z.object({ targetSubjectId: idSchema });
export type MoveFileRequest = z.infer<typeof moveFileBodySchema>;

export const createJobBodySchema = z.object({ kind: jobKindSchema });

export const createSessionBodySchema = z.object({
  lessonId: idSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof createSessionBodySchema>;

export const sendMessageBodySchema = z.object({
  content: z.string().min(1),
  lessonId: idSchema.optional(),
});
export type SendMessageRequest = z.infer<typeof sendMessageBodySchema>;

export const generateBodySchema = z.object({
  topic: z.string().min(1),
  count: z.number().int().min(1).max(20).optional(),
  difficulty: z.enum(['mixed', 'easy', 'medium', 'hard']).optional(),
  lessonId: idSchema.optional(),
});
export type GenerateQuestionsRequest = z.infer<typeof generateBodySchema>;

export const answerBodySchema = z.object({ answer: z.string().min(1) });

export const markdownBodySchema = z.object({ markdown: z.string() });

export const splitPdfBodySchema = z.object({ file: z.string().min(1) });
export type SplitPdfRequest = z.infer<typeof splitPdfBodySchema>;

export const splitPdfResponseSchema = z.object({ parts: z.array(z.string()) });
export type SplitPdfResponse = z.infer<typeof splitPdfResponseSchema>;

// ---- endpoint responses (composed) ----

export const graphInfoSchema = z.object({
  graphStatus: graphStatusSchema,
  stale: z.boolean(),
  lastBuiltAt: isoSchema.nullable(),
  hasGraph: z.boolean(),
  hasReport: z.boolean(),
  hasVerifyReport: z.boolean(),
});
export type GraphInfo = z.infer<typeof graphInfoSchema>;

export const graphReportSchema = z.object({
  graphReport: z.string().nullable(),
  verifyReport: z.string().nullable(),
});
export type GraphReport = z.infer<typeof graphReportSchema>;

export const wikiPageSchema = z.object({
  name: z.string(),
  markdown: z.string(),
  updatedAt: isoSchema,
});
export type WikiPage = z.infer<typeof wikiPageSchema>;

export const wikiPageSavedSchema = z.object({
  name: z.string(),
  updatedAt: isoSchema,
});
export type WikiPageSaved = z.infer<typeof wikiPageSavedSchema>;

export const answerResponseSchema = z.object({
  attemptId: idSchema,
  grade: gradeSchema,
  nextDueAt: isoSchema,
  intervalDays: z.number().int(),
});
export type AnswerResponse = z.infer<typeof answerResponseSchema>;

export const verifyKeyResponseSchema = z.object({
  keyStatus: z.enum(['verified', 'failed']),
  reason: z.string().optional(),
});
export type VerifyKeyResponse = z.infer<typeof verifyKeyResponseSchema>;

export const revealKeyResponseSchema = z.object({ key: questionKeySchema });
export type RevealKeyResponse = z.infer<typeof revealKeyResponseSchema>;

export const dueResponseSchema = z.object({
  date: isoSchema,
  questions: z.array(questionSchema),
});
export type DueResponse = z.infer<typeof dueResponseSchema>;

// ---- citation markers (parsed client-side with this shared regex) ----

/** Splits message text; odd indices are full `【file.pdf · p12】` markers. */
export const CITATION_RE = /(【[^】]*】)/g;
