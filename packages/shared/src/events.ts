import { z } from 'zod';
import { jobSchema, lessonSchema, questionSchema } from './api';
import { apiErrorPayloadSchema } from './errors';

// Subject SSE stream (GET /api/subjects/:id/events)
export const jobEventSchema = jobSchema;
export const lessonEventSchema = lessonSchema;
export const questionsEventSchema = z.object({
  subjectId: z.string(),
  questions: z.array(questionSchema),
});
export type QuestionsEvent = z.infer<typeof questionsEventSchema>;

// Chat SSE stream (POST /api/chat/sessions/:id/messages)
export const tokenEventSchema = z.object({ text: z.string() });
export const chatLessonEventSchema = lessonSchema;
export const chatQuizEventSchema = z.object({ questions: z.array(questionSchema) });
export type ChatStreamQuiz = z.infer<typeof chatQuizEventSchema>;
export const rotatedEventSchema = z.object({
  newSessionId: z.string(),
  summaryPath: z.string(),
});
export const doneEventSchema = z.object({ messageCount: z.number().int() });
export const chatErrorEventSchema = apiErrorPayloadSchema;

export type SubjectQuestionsEvent = QuestionsEvent;
