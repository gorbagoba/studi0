import { z } from 'zod';

export const errorCodes = [
  'VALIDATION',
  'SUBJECT_NOT_FOUND',
  'GROUP_NOT_FOUND',
  'NAME_TAKEN',
  'PATH_NOT_FOUND',
  'FILE_NOT_FOUND',
  'UNSUPPORTED_FILE_TYPE',
  'PATH_TRAVERSAL',
  'JOB_NOT_FOUND',
  'JOB_CONFLICT',
  'JOB_NOT_CANCELLABLE',
  'SESSION_NOT_FOUND',
  'SESSION_GONE',
  'TURN_IN_PROGRESS',
  'OPENCODE_DOWN',
  'QUESTION_NOT_FOUND',
  'KEY_NOT_VERIFIED',
  'INTERNAL',
] as const;

export const errorCodeSchema = z.enum(errorCodes);
export type ErrorCode = (typeof errorCodes)[number];

export const apiErrorPayloadSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorPayload = z.infer<typeof apiErrorPayloadSchema>;
