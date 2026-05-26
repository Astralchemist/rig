// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from 'bun:test';
import { isNewer } from '../packages/cli/src/update-cmd.ts';

describe('rig update — version comparison', () => {
  test('detects a newer patch / minor / major', () => {
    expect(isNewer('0.1.3', '0.1.4')).toBe(true);
    expect(isNewer('0.1.4', '0.2.0')).toBe(true);
    expect(isNewer('0.9.9', '1.0.0')).toBe(true);
  });

  test('equal or older is not newer', () => {
    expect(isNewer('0.1.4', '0.1.4')).toBe(false);
    expect(isNewer('0.1.4', '0.1.3')).toBe(false);
    expect(isNewer('1.0.0', '0.9.9')).toBe(false);
  });

  test('handles uneven segment counts', () => {
    expect(isNewer('0.1', '0.1.1')).toBe(true);
    expect(isNewer('0.1.0', '0.1')).toBe(false);
  });

  test('a prerelease on an equal core is not treated as newer', () => {
    expect(isNewer('0.1.4', '0.1.4-rc.1')).toBe(false);
  });
});
