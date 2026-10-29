// SPDX-License-Identifier: Apache-2.0
import { extractSettled } from '@rig/core/capture/extractor.ts';
import type { SettledRecord } from '@rig/core/capture/types.ts';
import type { CaptureFixture } from './capture-fixtures.ts';

// Precision / recall of the extractor over fixtures. A record matches an
// expected one when the kind is the same and the summary contains the
// expected fragment; each expected record matches at most one emitted record.
export interface FixtureOutcome {
  name: string;
  records: SettledRecord[];
  tp: number;
  fp: SettledRecord[];
  fn: CaptureFixture['expect'];
}

export interface Score {
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  outcomes: FixtureOutcome[];
}

export const scoreFixtures = (fixtures: readonly CaptureFixture[]): Score => {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  const outcomes: FixtureOutcome[] = [];
  for (const f of fixtures) {
    const records = extractSettled({ session_id: f.name, events: f.events });
    const left = [...records];
    const missed: CaptureFixture['expect'] = [];
    let hit = 0;
    for (const e of f.expect) {
      const i = left.findIndex(
        (r) => r.kind === e.kind && r.summary.toLowerCase().includes(e.includes),
      );
      if (i >= 0) {
        left.splice(i, 1);
        hit++;
      } else missed.push(e);
    }
    tp += hit;
    fp += left.length;
    fn += missed.length;
    outcomes.push({ name: f.name, records, tp: hit, fp: left, fn: missed });
  }
  return {
    tp,
    fp,
    fn,
    precision: tp + fp ? tp / (tp + fp) : 1,
    recall: tp + fn ? tp / (tp + fn) : 1,
    outcomes,
  };
};
