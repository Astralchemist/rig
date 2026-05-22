import { z } from 'zod';
import { targetNameSchema } from '../shared.ts';
import type { TargetName } from '../shared.ts';

export const FILE_MODES = ['merge-json', 'append-section', 'replace', 'write-toml'] as const;
export type FileMode = (typeof FILE_MODES)[number];

export const FILE_ROLES = ['mcp_config', 'permissions', 'instructions'] as const;
export type FileRole = (typeof FILE_ROLES)[number];

const targetFileSchema = z
  .object({
    role: z.enum(FILE_ROLES),
    path: z.string().min(1),
    mode: z.enum(FILE_MODES),
    section_marker: z.string().optional(),
    template: z.unknown(),
  })
  .strict();

export const targetContractSchema = z
  .object({
    name: targetNameSchema,
    display_name: z.string().min(1),
    detect: z.function().args().returns(z.promise(z.boolean())),
    files: z.array(targetFileSchema).min(1),
    uninstall_strategy: z.enum(['reverse', 'manual']).default('reverse'),
  })
  .strict();

export interface TargetFile {
  role: FileRole;
  path: string;
  mode: FileMode;
  section_marker?: string;
  template: unknown;
}

export interface TargetContract {
  name: TargetName;
  display_name: string;
  detect: () => Promise<boolean>;
  files: TargetFile[];
  uninstall_strategy?: 'reverse' | 'manual';
}

export const defineTargetContract = <T extends TargetContract>(c: T): T => c;
