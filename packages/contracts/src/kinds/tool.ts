// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { ZodTypeAny } from 'zod';
import { permissionLevelSchema, targetNameSchema, zodSchema } from '../shared.ts';
import type { PermissionLevel, TargetName } from '../shared.ts';

export const TOOL_TIERS = ['light', 'heavy', 'write', 'live'] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];

export const TOOL_STABILITIES = ['stable', 'experimental', 'deprecated'] as const;
export type ToolStability = (typeof TOOL_STABILITIES)[number];

export const toolContractSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^rig_[a-z][a-z0-9_]*$/, 'must start with rig_ and be snake_case'),
    tier: z.enum(TOOL_TIERS),
    summary: z.string().min(1).max(60),
    description: z.string().min(10),
    input: zodSchema,
    output: zodSchema,
    errors: z.array(z.string().min(1)).default([]),
    permissions: z.record(targetNameSchema, permissionLevelSchema).default({}),
    // stability axis — drives the compat gate. Experimental tools are exempt
    // from breaking-change failures; stable tools are protected until a major
    // manifest bump. See COMPATIBILITY.md.
    stability: z.enum(TOOL_STABILITIES).default('experimental'),
    since: z.string().optional(), // manifest version a tool became stable, e.g. '1.0'
    deprecated_in: z.string().optional(),
    replaced_by: z
      .string()
      .regex(/^rig_[a-z][a-z0-9_]*$/)
      .optional(),
    // tier-specific (validated by refinement below)
    records_activation: z.boolean().optional(),
    provenance_required: z.boolean().optional(),
    broadcasts: z.string().optional(),
    inverse: z.string().optional(),
    requires_rationale: z.boolean().optional(),
    subscription_kind: z.string().optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.tier === 'write' && !c.provenance_required) {
      ctx.addIssue({ code: 'custom', message: 'write tier requires provenance_required: true' });
    }
    if (c.tier === 'live' && !c.subscription_kind) {
      ctx.addIssue({ code: 'custom', message: 'live tier requires subscription_kind' });
    }
    if (c.stability === 'deprecated' && !c.deprecated_in) {
      ctx.addIssue({ code: 'custom', message: 'deprecated tools require deprecated_in' });
    }
  });

export interface ToolContract {
  name: string;
  tier: ToolTier;
  summary: string;
  description: string;
  input: ZodTypeAny;
  output: ZodTypeAny;
  errors?: readonly string[];
  permissions?: Partial<Record<TargetName, PermissionLevel>>;
  stability?: ToolStability;
  since?: string;
  deprecated_in?: string;
  replaced_by?: string;
  records_activation?: boolean;
  provenance_required?: boolean;
  broadcasts?: string;
  inverse?: string;
  requires_rationale?: boolean;
  subscription_kind?: string;
}

export const defineToolContract = <T extends ToolContract>(c: T): T => c;
