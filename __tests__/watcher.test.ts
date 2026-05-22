import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileWatcher } from '../packages/core/src/watch.ts';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('FileWatcher debounce + filtering', () => {
  let project: string;

  beforeEach(() => {
    project = mkdtempSync(join(tmpdir(), 'rig-watcher-'));
    // Force-enable the watcher even on WSL2 /mnt/ drives.
    process.env.RIG_FORCE_WATCH = '1';
  });

  afterEach(() => {
    delete process.env.RIG_FORCE_WATCH;
    rmSync(project, { recursive: true, force: true });
  });

  test('rapid writes collapse into one sync via debounce', async () => {
    let syncCount = 0;
    const watcher = new FileWatcher(
      project,
      async () => {
        syncCount++;
        return { filesChanged: 0, durationMs: 0 };
      },
      { debounceMs: 100 },
    );
    const started = watcher.start();
    if (!started) {
      // Recursive fs.watch not supported on this platform — skip.
      return;
    }
    for (let i = 0; i < 5; i++) writeFileSync(join(project, `f${i}.ts`), `export const x${i} = ${i};`);
    await sleep(400);
    expect(syncCount).toBe(1);
    watcher.stop();
  });

  test('changes inside .rig/ are ignored', async () => {
    mkdirSync(join(project, '.rig'), { recursive: true });
    let syncCount = 0;
    const watcher = new FileWatcher(
      project,
      async () => {
        syncCount++;
        return { filesChanged: 0, durationMs: 0 };
      },
      { debounceMs: 100 },
    );
    const started = watcher.start();
    if (!started) return;
    writeFileSync(join(project, '.rig', 'rig.db'), 'fake');
    writeFileSync(join(project, '.rig', 'rig.db-wal'), 'fake');
    await sleep(300);
    expect(syncCount).toBe(0);
    watcher.stop();
  });
});
