import type { ErrorCode } from '@studi0/shared';

export const statusForCode: Record<ErrorCode, number> = {
  VALIDATION: 400,
  PATH_NOT_FOUND: 400,
  PATH_TRAVERSAL: 400,
  SUBJECT_NOT_FOUND: 404,
  FILE_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  SESSION_NOT_FOUND: 404,
  QUESTION_NOT_FOUND: 404,
  TURN_IN_PROGRESS: 409,
  NAME_TAKEN: 409,
  JOB_CONFLICT: 409,
  JOB_NOT_CANCELLABLE: 409,
  KEY_NOT_VERIFIED: 409,
  SESSION_GONE: 410,
  UNSUPPORTED_FILE_TYPE: 415,
  OPENCODE_DOWN: 503,
  INTERNAL: 500,
};

export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  get status(): number {
    return statusForCode[this.code];
  }
}
