import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { readState } from './_state.ts';

const state = readState();
const HERE = dirname(fileURLToPath(import.meta.url));
const uiBuilt = existsSync(resolve(HERE, '../packages/web/dist/index.html'));

// The map requires its session token even on loopback. These walk the ways a
// user signs in: the gate, a pasted token, and the login link `rig start` opens.
test.describe('sign-in gate', () => {
  test.skip(!uiBuilt, 'needs the built UI: bun run build:web');

  const gate = (page: import('@playwright/test').Page) =>
    page.getByRole('heading', { name: 'Rig — sign in' });

  test('without the token the map shows the gate and the API refuses', async ({ page }) => {
    await page.goto(state.url);
    await expect(gate(page)).toBeVisible();
    expect((await page.request.get('/api/status')).status()).toBe(401);
  });

  test('pasting the token signs in', async ({ page }) => {
    await page.goto(state.url);
    await page.getByPlaceholder('paste token here').fill(state.token);
    await page.getByRole('button', { name: 'sign in' }).click();
    await expect(gate(page)).toBeHidden();
    expect((await page.request.get('/api/status')).status()).toBe(200);
  });

  test('a wrong token is refused', async ({ page }) => {
    await page.goto(state.url);
    await page.getByPlaceholder('paste token here').fill('not-the-token');
    await page.getByRole('button', { name: 'sign in' }).click();
    await expect(page.getByText('invalid token')).toBeVisible();
    expect((await page.request.get('/api/status')).status()).toBe(401);
  });

  test('the login link lands on the map, signed in', async ({ page }) => {
    await page.goto(state.loginUrl);
    await expect(page).toHaveURL(`${state.url}/`);
    await expect(gate(page)).toHaveCount(0);
    expect((await page.request.get('/api/status')).status()).toBe(200);
  });
});
