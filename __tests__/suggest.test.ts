// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { suggestCommand } from '../packages/cli/src/suggest.ts';

const COMMANDS = [
  'start', 'init', 'status', 'index', 'sync', 'query', 'files',
  'install', 'serve', 'doctor', 'bench', 'export-docs', 'update',
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

  test('far-off gibberish suggests nothing', () => {
    expect(suggestCommand('xyzzy', COMMANDS)).toBeNull();
    expect(suggestCommand('frobnicate', COMMANDS)).toBeNull();
  });

  test('an exact command is its own nearest match (distance 0)', () => {
    expect(suggestCommand('serve', COMMANDS)).toBe('serve');
  });
});
