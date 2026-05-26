// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stablePort } from '../packages/cli/src/init.ts';
import { resolvePort, resolveProjectName } from '../packages/web/src/index.ts';

const PORT_BASE = 7474;
const PORT_SPAN = 64;

const withConfig = (cfg: Record<string, unknown>): string => {
  const root = mkdtempSync(join(tmpdir(), 'rig-port-'));
  mkdirSync(join(root, '.rig'), { recursive: true });
  writeFileSync(join(root, '.rig', 'config.json'), JSON.stringify(cfg));
  return root;
};

describe('#17 — doctor/serve read the resolved per-project port', () => {
  test('resolvePort: explicit flag wins over config and default', () => {
    const root = withConfig({ port: 7510 });
    expect(resolvePort(root, 9999)).toBe(9999);
  });

  test('resolvePort: reads port from .rig/config.json', () => {
    const root = withConfig({ port: 7510 });
    expect(resolvePort(root)).toBe(7510);
  });

  test('resolvePort: falls back to 7474 with no config', () => {
    const root = mkdtempSync(join(tmpdir(), 'rig-port-'));
    expect(resolvePort(root)).toBe(PORT_BASE);
  });

  test('resolveProjectName: reads name from config, else basename', () => {
    expect(resolveProjectName(withConfig({ name: 'alpha-svc' }))).toBe('alpha-svc');
    const noName = mkdtempSync(join(tmpdir(), 'rig-named-'));
    expect(resolveProjectName(noName).length).toBeGreaterThan(0);
  });

  test('stablePort: deterministic and inside the 7474–7537 window', () => {
    const root = mkdtempSync(join(tmpdir(), 'rig-stable-'));
    const p = stablePort(root);
    expect(p).toBe(stablePort(root));
    expect(p).toBeGreaterThanOrEqual(PORT_BASE);
    expect(p).toBeLessThan(PORT_BASE + PORT_SPAN);
  });
});
