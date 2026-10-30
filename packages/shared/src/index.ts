import { z } from 'zod';

export const healthSchema = z.object({ ok: z.boolean() });

export type Health = z.infer<typeof healthSchema>;
