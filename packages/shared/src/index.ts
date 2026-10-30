import { z } from 'zod';
import { opencodeHealthSchema } from './api';

export * from './errors';
export * from './api';
export * from './quiz';
export * from './events';

export const healthSchema = z.object({
  ok: z.boolean(),
  opencode: opencodeHealthSchema,
});

export type Health = z.infer<typeof healthSchema>;
