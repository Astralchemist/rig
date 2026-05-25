// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';

export const migrationContractSchema = z
  .object({
    version: z.number().int().min(1),
    description: z.string().min(1),
    applied_in_phase: z.number().int().min(0).max(9),
    forward: z.string().min(1),
    rollback: z.string().min(1),
  })
  .strict();

export interface MigrationContract {
  version: number;
  description: string;
  applied_in_phase: number;
  forward: string;
  rollback: string;
}

export const defineMigrationContract = <T extends MigrationContract>(c: T): T => c;
