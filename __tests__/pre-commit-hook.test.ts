import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const HOOK = resolve(__dirname, '../.git/hooks/pre-commit');

describe('pre-commit hook (Phase 1.5 §9 acceptance)', () => {
  test('hook is installed at .git/hooks/pre-commit', () => {
    expect(existsSync(HOOK)).toBe(true);
  });

  test('hook is executable', () => {
    const mode = statSync(HOOK).mode & 0o777;
    // Owner exec bit must be set (0o100).
    expect(mode & 0o100).toBe(0o100);
  });

  test('hook runs `bun run gen:check`', () => {
    const body = readFileSync(HOOK, 'utf-8');
    expect(body).toContain('gen:check');
  });
});
