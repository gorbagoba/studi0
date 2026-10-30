import { z } from 'zod';

export const quizOptionSchema = z.object({ id: z.string(), text: z.string() });

export const quizKeySchema = z.object({
  answerIndex: z.number().int().min(0).optional(),
  answer: z.string().optional(),
  rubric: z.string().optional(),
});

export const quizQuestionSchema = z.object({
  topic: z.string().min(1),
  type: z.enum(['mcq', 'short', 'code']),
  prompt: z.string().min(1),
  options: z.array(quizOptionSchema).min(2).optional(),
  rubric: z.string().optional(),
  key: quizKeySchema,
});
export type QuizQuestion = z.infer<typeof quizQuestionSchema>;

export const quizSpecSchema = z.object({
  topic: z.string().min(1),
  questions: z.array(quizQuestionSchema).min(1).max(10),
});
export type QuizSpec = z.infer<typeof quizSpecSchema>;
