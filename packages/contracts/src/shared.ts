import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

export const TARGET_NAMES = ['claude', 'cursor', 'codex', 'opencode', 'hermes'] as const;
export type TargetName = (typeof TARGET_NAMES)[number];
export const targetNameSchema = z.enum(TARGET_NAMES);

export const PERMISSION_LEVELS = ['auto-allow', 'allow', 'ask', 'deny'] as const;
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number];
export const permissionLevelSchema = z.enum(PERMISSION_LEVELS);

export const isZodSchema = (v: unknown): v is ZodTypeAny =>
  !!v && typeof v === 'object' && '_def' in v && typeof (v as { parse?: unknown }).parse === 'function';

export const zodSchema = z.custom<ZodTypeAny>(isZodSchema, { message: 'must be a Zod schema' });
