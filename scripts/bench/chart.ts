// SPDX-License-Identifier: Apache-2.0
// bench:chart: regenerate docs/bench/*.svg from the results files. No network
// and no clock: the manifest is rebuilt in memory from the results and the
// committed index.json's model metadata, so the same results always give the
// same bytes. `--check` fails when a committed chart is out of date.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  memoryChartData,
  qaChartData,
  renderCrossModelChart,
  renderMemoryChart,
  renderQaChart,
} from './charts.ts';
import {
  buildIndex,
  isSessionsFile,
  loadIndex,
  loadLineup,
  loadResultsDir,
  RESULTS_DIR,
} from './models.ts';
import { DEFAULT_MODELS } from './providers.ts';
import { modelRows, selectSessions } from './report-models.ts';
import type { BenchFile } from './types.ts';

export const CHARTS_DIR = resolve(import.meta.dir, '../../docs/bench');

/** Every chart, by file name, from the results in `dir`. */
export const renderAll = (
  dir: string = RESULTS_DIR,
  model: string = DEFAULT_MODELS.openrouter,
): Record<string, string> => {
  const files = loadResultsDir(dir);
  const index = buildIndex({
    files,
    catalogue: null,
    previous: loadIndex(join(dir, 'index.json')),
    lineup: loadLineup(),
    asOf: null,
  });
  const own = files.map((f) => f.data).filter((f) => f.model === model);
  const sessions = selectSessions(own.filter(isSessionsFile));
  const byFile = new Map(files.map((f) => [f.file, f.data]));
  return {
    'memory.svg': renderMemoryChart(sessions ? memoryChartData(sessions) : null, model),
    'qa-tokens.svg': renderQaChart(
      qaChartData(
        own.filter((f): f is BenchFile => !isSessionsFile(f)),
        model,
      ),
    ),
    'cross-model.svg': renderCrossModelChart(
      modelRows(index, (run) => byFile.get(run.file)!),
      index.tier_threshold_usd_per_m_input,
    ),
  };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const value = (n: string): string | undefined => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = resolve(value('--out') ?? CHARTS_DIR);
  const charts = renderAll(resolve(value('--results') ?? RESULTS_DIR));
  if (args.includes('--check')) {
    const stale = Object.entries(charts).filter(
      ([name, svg]) =>
        !existsSync(join(out, name)) || readFileSync(join(out, name), 'utf-8') !== svg,
    );
    if (stale.length) {
      console.error(
        `bench:chart: out of date: ${stale.map(([n]) => n).join(', ')}; run bun run bench:chart`,
      );
      process.exit(1);
    }
    console.log(`bench:chart: ${Object.keys(charts).length} charts up to date`);
  } else {
    mkdirSync(out, { recursive: true });
    for (const [name, svg] of Object.entries(charts)) {
      writeFileSync(join(out, name), svg);
      console.log(`wrote ${join(out, name)}`);
    }
  }
}
