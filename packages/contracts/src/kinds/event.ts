import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { zodSchema } from '../shared.ts';

export const eventContractSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z_]*:[a-z][a-z_]*$/, 'must be lowercase namespace:event'),
    emitted_by: z.array(z.string().min(1)).default([]),
    payload: zodSchema,
    ui_effect: z.string().optional(),
  })
  .strict();

export interface EventContract {
  name: string;
  emitted_by?: string[];
  payload: ZodTypeAny;
  ui_effect?: string;
}

export const defineEventContract = <T extends EventContract>(c: T): T => c;
