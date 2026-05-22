export { defineToolContract, toolContractSchema, TOOL_TIERS } from './kinds/tool.ts';
export type { ToolContract, ToolTier } from './kinds/tool.ts';

export { defineAnchorContract, anchorContractSchema, EXTRACTOR_KINDS } from './kinds/anchor.ts';
export type { AnchorContract, ExtractorKind } from './kinds/anchor.ts';

export { defineTargetContract, targetContractSchema, FILE_MODES, FILE_ROLES } from './kinds/target.ts';
export type { TargetContract, TargetFile, FileMode, FileRole } from './kinds/target.ts';

export { defineMigrationContract, migrationContractSchema } from './kinds/migration.ts';
export type { MigrationContract } from './kinds/migration.ts';

export { defineEventContract, eventContractSchema } from './kinds/event.ts';
export type { EventContract } from './kinds/event.ts';

export { TARGET_NAMES, PERMISSION_LEVELS } from './shared.ts';
export type { TargetName, PermissionLevel } from './shared.ts';

export const CONTRACT_KINDS = ['tools', 'anchors', 'targets', 'migrations', 'events'] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];
