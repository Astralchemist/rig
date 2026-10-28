// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { suggestCommand } from '../packages/cli/src/suggest.ts';

const COMMANDS = [
  'start', 'init', 'status', 'index', 'sync', 'query', 'files',
  'install', 'uninstall', 'serve', 'doctor', 'bench', 'export-docs',
  'export-memory', 'import-memory', 'update',
];

describe('rig — did-you-mean command suggestions', () => {
  test('common typos map to the right command', () => {
    expect(suggestCommand('server', COMMANDS)).toBe('serve');
    expect(suggestCommand('statuss', COMMANDS)).toBe('status');
    expect(suggestCommand('udpate', COMMANDS)).toBe('update');
    expect(suggestCommand('exprt-docs', COMMANDS)).toBe('export-docs');
  });

  test('agent names route to `install <agent>`', () => {
    expect(suggestCommand('claude', COMMANDS)).toBe('install claude');
    expect(suggestCommand('cursor', COMMANDS)).toBe('install cursor');
    expect(suggestCommand('openrouter', COMMANDS)).toBe('install openrouter');
  });

  test('uninstall: typos, and the words people use instead', () => {
    expect(suggestCommand('uninstal', COMMANDS)).toBe('uninstall');
    // edit distance alone says `serve` / `install` — the opposite of the intent
    expect(suggestCommand('remove', COMMANDS)).toBe('uninstall');
    expect(suggestCommand('deinstall', COMMANDS)).toBe('uninstall');
    expect(suggestCommand('unwire', COMMANDS)).toBe('uninstall');
    expect(suggestCommand('rm', COMMANDS)).toBe('uninstall');
    expect(suggestCommand('wire', COMMANDS)).toBe('install');
  });

  test('memory export/import: typos, and the words people use instead', () => {
    expect(suggestCommand('export-memroy', COMMANDS)).toBe('export-memory');
    expect(suggestCommand('import-memories', COMMANDS)).toBe('import-memory');
    // edit distance alone finds nothing for these
    expect(suggestCommand('backup', COMMANDS)).toBe('export-memory');
    expect(suggestCommand('import', COMMANDS)).toBe('import-memory');
    expect(suggestCommand('restore', COMMANDS)).toBe('import-memory');
  });

  test('far-off gibberish suggests nothing', () => {
    expect(suggestCommand('xyzzy', COMMANDS)).toBeNull();
    expect(suggestCommand('frobnicate', COMMANDS)).toBeNull();
  });

  test('an exact command is its own nearest match (distance 0)', () => {
    expect(suggestCommand('serve', COMMANDS)).toBe('serve');
  });
});
