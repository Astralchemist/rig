// SPDX-License-Identifier: Apache-2.0
// Node kinds folded into five groups for colour. A force layout is a
// scatter-like form where any two marks can sit side by side, so only three
// categorical slots validate all-pairs (dataviz palette, both modes). Code
// symbols take those three; files, docs and dependencies stay neutral, and
// agent memory gets the memory ink. Shape is the secondary encoding, so
// identity never rests on colour alone.

export type GroupId = 'callable' | 'type' | 'value' | 'file' | 'memory';
export type Shape = 'circle' | 'square' | 'diamond' | 'ring' | 'triangle';

export interface KindGroup {
  id: GroupId;
  label: string;
  shape: Shape;
  // CSS variable holding the colour; the canvas resolves it via GraphPalette.
  cssVar: string;
}

export const GROUPS: KindGroup[] = [
  { id: 'callable', label: 'Functions', shape: 'circle', cssVar: '--series-1' },
  { id: 'type', label: 'Types', shape: 'square', cssVar: '--series-2' },
  { id: 'value', label: 'Values', shape: 'diamond', cssVar: '--series-3' },
  { id: 'file', label: 'Files & docs', shape: 'ring', cssVar: '--node-neutral' },
  { id: 'memory', label: 'Agent memory', shape: 'triangle', cssVar: '--node-memory' },
];

const BY_KIND = new Map<string, GroupId>(
  Object.entries({
    function: 'callable',
    method: 'callable',
    class: 'type',
    struct: 'type',
    interface: 'type',
    trait: 'type',
    protocol: 'type',
    enum: 'type',
    type_alias: 'type',
    property: 'value',
    field: 'value',
    variable: 'value',
    constant: 'value',
    enum_member: 'value',
    parameter: 'value',
    file: 'file',
    module: 'file',
    namespace: 'file',
    'markdown-section': 'file',
    'declared-dependency': 'file',
    import: 'file',
    'conversation-waypoint': 'memory',
    cluster: 'memory',
    skill: 'memory',
    concept: 'memory',
  } satisfies Record<string, GroupId>),
);

export const groupOf = (kind: string): KindGroup => {
  const id = BY_KIND.get(kind) ?? (kind.includes('waypoint') ? 'memory' : 'file');
  return GROUPS.find((g) => g.id === id)!;
};

const LABELS: Record<string, string> = {
  'conversation-waypoint': 'waypoint',
  'markdown-section': 'doc section',
  'declared-dependency': 'dependency',
  type_alias: 'type alias',
  enum_member: 'enum member',
};

export const kindLabel = (kind: string): string => LABELS[kind] ?? kind.replace(/_/g, ' ');
