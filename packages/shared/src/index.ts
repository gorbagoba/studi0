import { z } from 'zod';
import { opencodeHealthSchema, activeJobSchema, isoSchema } from './api';

export * from './errors';
export * from './api';
export * from './quiz';
export * from './events';

export const healthSchema = z.object({
  ok: z.boolean(),
  opencode: opencodeHealthSchema,
  uptime_s: z.number().int(),
  db: z.string(),
  probed_at: isoSchema,
  jobs: z.array(activeJobSchema),
});

export type Health = z.infer<typeof healthSchema>;
