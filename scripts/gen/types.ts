// SPDX-License-Identifier: Apache-2.0
import type {
  AnchorContract,
  ContractKind,
  EventContract,
  MigrationContract,
  TargetContract,
  ToolContract,
} from '@rig/contracts';

export interface ContractMap {
  tools: ToolContract;
  anchors: AnchorContract;
  targets: TargetContract;
  migrations: MigrationContract;
  events: EventContract;
}

export interface LoadedContract<K extends ContractKind = ContractKind> {
  kind: K;
  file: string;
  absFile: string;
  basename: string;
  data: ContractMap[K];
}

export interface GeneratedFile {
  path: string;
  content: string;
  source: string[];
}
