import { expect, test } from '@playwright/test';
import { readState } from './_state.ts';

const state = readState();

test('app boots without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) errors.push(`http: ${r.status()} ${r.url()}`);
  });
  await page.goto(state.loginUrl);
  await page.waitForLoadState('networkidle');
  // Give React a beat to finish hydration.
  await page.waitForTimeout(500);
  if (errors.length > 0) console.log('CAUGHT:', errors.join('\n'));
  expect(errors).toEqual([]);
});
