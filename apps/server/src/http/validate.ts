import { z } from 'zod';
import { HttpError } from '../util/errors.js';

/** Parse a trust-boundary input with a shared zod schema; 400 VALIDATION on failure. */
export function parseWith<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new HttpError('VALIDATION', 'invalid request', z.flattenError(result.error));
  }
  return result.data;
}
