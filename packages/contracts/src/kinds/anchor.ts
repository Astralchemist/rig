// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { zodSchema } from '../shared.ts';

export const EXTRACTOR_KINDS = ['tree-sitter', 'custom', 'manual'] as const;
export type ExtractorKind = (typeof EXTRACTOR_KINDS)[number];

export const anchorContractSchema = z
  .object({
    type: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9-]*$/, 'must be lowercase kebab-case'),
    description: z.string().min(1),
    extractor: z.enum(EXTRACTOR_KINDS),
    data_schema: zodSchema,
    ui: z
      .object({
        icon: z.string().min(1),
        color: z.string().min(1),
        label_field: z.string().min(1),
        detail_fields: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    allowed_edges: z
      .object({
        outgoing: z.array(z.string().min(1)).default([]),
        incoming: z.array(z.string().min(1)).default([]),
      })
      .strict(),
    embeddable: z.boolean().default(false),
    embedding_text: z.array(z.string().min(1)).default([]),
  })
  .strict();

export interface AnchorContract {
  type: string;
  description: string;
  extractor: ExtractorKind;
  data_schema: ZodTypeAny;
  ui: { icon: string; color: string; label_field: string; detail_fields?: string[] };
  allowed_edges: { outgoing?: string[]; incoming?: string[] };
  embeddable?: boolean;
  embedding_text?: string[];
}

export const defineAnchorContract = <T extends AnchorContract>(c: T): T => c;
