// Derived from CodeGraph (MIT) — github.com/colbymchenry/codegraph
/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers
 * debounced sync operations to keep the code graph up-to-date.
 *
 * Uses Node.js native fs.watch with recursive mode (macOS FSEvents,
 * Windows ReadDirectoryChangesW, Linux inotify on Node 19+).
 */

import * as fs from 'node:fs';
import { logDebug, logWarn } from './errors.ts';
import { isSupportedSource as isSourceFile } from './extract/grammars.ts';
import { SKIP_DIRS } from './extract/walker.ts';
import { normalizePath } from './utils.ts';
import { watchDisabledReason } from './watch-policy.ts';

/**
 * Options for the file watcher
 */
export interface WatchOptions {
  /**
   * Debounce delay in milliseconds.
   * After the last file change, wait this long before triggering sync.
   * Default: 2000ms
   */
  debounceMs?: number;

  /**
   * Callback when a sync completes (for logging/diagnostics).
   */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;

  /**
   * Callback when a sync errors (for logging/diagnostics).
   */
  onSyncError?: (error: Error) => void;

  /**
   * How many times a failed sync is retried (one debounce apart) before the
   * watcher waits for the next change. Covers transient failures such as
   * SQLITE_BUSY while another process writes. Default: 3
   */
  maxRetries?: number;
}

/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (native OS file events, no polling)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters to supported source files by extension
 * - Ignores .rig/ directory changes
 */
export class FileWatcher {
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private hasChanges = false;
  private syncing = false;
  private stopped = false;
  private failures = 0;

  private readonly projectRoot: string;
  private readonly debounceMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];
  private readonly maxRetries: number;

  constructor(
    projectRoot: string,
    syncFn: () => Promise<{ filesChanged: number; durationMs: number }>,
    options: WatchOptions = {}
  ) {
    this.projectRoot = projectRoot;
    this.syncFn = syncFn;
    this.debounceMs = options.debounceMs ?? 2000;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Start watching for file changes.
   * Returns true if watching started successfully, false otherwise.
   */
  start(): boolean {
    if (this.watcher) return true; // Already watching
    this.stopped = false;

    // Some environments make recursive fs.watch unusable — most notably WSL2
    // /mnt/ drives, where setup blocks long enough to break MCP startup
    // handshakes (issue #199). Skip watching there; callers fall back to
    // manual `rig sync` or the git sync hooks.
    const disabledReason = watchDisabledReason(this.projectRoot);
    if (disabledReason) {
      logDebug('File watcher disabled', { reason: disabledReason, projectRoot: this.projectRoot });
      return false;
    }

    try {
      this.watcher = fs.watch(
        this.projectRoot,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename || this.stopped) return;

          // Normalize path separators
          const normalized = normalizePath(filename);

          // Ignore .rig/ (our own DB writes) and every other directory the
          // walker skips (node_modules, .git, dist, ...): a sync would find
          // nothing there to index.
          if (normalized.split('/').some((segment) => SKIP_DIRS.has(segment))) {
            return;
          }

          // Only sync changes to files we can actually parse.
          if (!isSourceFile(normalized)) {
            return;
          }

          logDebug('File change detected', { file: normalized });
          this.hasChanges = true;
          this.scheduleSync();
        }
      );

      // Handle watcher errors gracefully
      this.watcher.on('error', (err) => {
        logWarn('File watcher error', { error: String(err) });
        // Don't crash — watcher may recover or user can restart
      });

      logDebug('File watcher started', { projectRoot: this.projectRoot, debounceMs: this.debounceMs });
      return true;
    } catch (err) {
      // Recursive watch not supported (e.g., Linux < Node 19)
      logWarn('Could not start file watcher — recursive fs.watch not supported on this platform', { error: String(err) });
      return false;
    }
  }

  /**
   * Stop watching for file changes.
   */
  stop(): void {
    this.stopped = true;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.hasChanges = false;
    logDebug('File watcher stopped');
  }

  /**
   * Queue a sync as if a file had changed, e.g. to catch up on edits made
   * while no watcher was running.
   */
  requestSync(): void {
    if (this.stopped) return;
    this.hasChanges = true;
    this.scheduleSync();
  }

  /**
   * Whether the watcher is currently active.
   */
  isActive(): boolean {
    return this.watcher !== null && !this.stopped;
  }

  /**
   * Schedule a debounced sync.
   */
  private scheduleSync(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.flush();
    }, this.debounceMs);
  }

  /**
   * Flush pending changes by running sync.
   */
  private async flush(): Promise<void> {
    // If already syncing, the post-sync check will re-trigger
    if (this.syncing || this.stopped) return;

    this.hasChanges = false;
    this.syncing = true;

    try {
      const result = await this.syncFn();
      this.failures = 0;
      this.onSyncComplete?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logWarn('Watch sync failed', { error: error.message });
      this.onSyncError?.(error);
      // Nothing was committed for a failed sync; try again unless it keeps
      // failing, in which case the next file change retries.
      if (++this.failures <= this.maxRetries) this.hasChanges = true;
    } finally {
      this.syncing = false;

      // If new changes arrived during sync, schedule another
      if (this.hasChanges && !this.stopped) {
        this.scheduleSync();
      }
    }
  }
}
