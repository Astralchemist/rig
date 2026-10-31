import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { readState } from './_state.ts';

// The map's views: shell, search, inspector, the React Flow lenses, review
// with accept and undo, live waypoints and notes, overview, keyboard and
// narrow-screen behaviour. Runs before multi-tab-sync and
// propose-accept-undo and only touches the third seeded proposal.

const state = readState();
const HERE = dirname(fileURLToPath(import.meta.url));
const uiBuilt = existsSync(resolve(HERE, '../packages/web/dist/index.html'));

const write = (...args: string[]): void => {
  execFileSync('bun', ['run', resolve(HERE, '_write.ts'), state.projectRoot, ...args], {
    stdio: 'ignore',
  });
};

const signIn = async (page: Page, hash = ''): Promise<void> => {
  await page.goto(state.loginUrl);
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  if (hash) await page.goto(`${state.url}/${hash}`);
};

test.describe('map UI', () => {
  test.skip(!uiBuilt, 'needs the built UI: bun run build:web');

  test('the shell renders the rail, the live indicator and the constellation', async ({ page }) => {
    await signIn(page);
    const rail = page.getByRole('navigation', { name: 'Views' });
    for (const name of ['Map', 'Waypoints', 'Overview'])
      await expect(rail.getByRole('button', { name })).toBeVisible();
    await expect(rail.getByRole('button', { name: /Review, \d+ pending/ })).toBeVisible();
    await expect(page.locator('.live')).toHaveText('Live', { timeout: 5000 });
    await expect(
      page.getByRole('application', { name: /Constellation of \d+ nodes/ }),
    ).toBeVisible();
    await expect(page.locator('canvas').first()).toBeVisible();
  });

  test('search keeps the first keystroke, says how it ranked, and opens the hit', async ({
    page,
  }) => {
    await signIn(page);
    await page.keyboard.press('Control+k');
    // Typed at once, without waiting for the palette to settle.
    await page.keyboard.type('login');
    const input = page.getByRole('combobox', { name: 'Search' });
    await expect(input).toHaveValue('login');
    const first = page.getByRole('option').first();
    await expect(first).toContainText('login');
    // Hybrid when the embedding model is available here, keyword-only when
    // it isn't; either way the footer says which, matching the header.
    const res = await page.request.get('/api/search?q=login');
    const mode = res.headers()['x-rig-search'];
    expect(['hybrid', 'keyword-only']).toContain(mode);
    await expect(page.locator('.palette-foot .mode')).toContainText(
      mode === 'hybrid' ? 'Hybrid' : 'Keywords only',
    );
    await page.keyboard.press('Enter');
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByRole('heading', { name: 'login' })).toBeVisible();
    await expect(inspector).toContainText('auth.ts:1');
  });

  test('the inspector shows notes, waypoints and the badges', async ({ page }) => {
    await signIn(page, `#${state.srcId}`);
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByRole('heading', { name: 'login' })).toBeVisible();
    await expect(inspector).toContainText('e2e seed note: called on every render');
    await expect(inspector.getByText(/1 note/)).toBeVisible();
    await expect(inspector.getByText(/1 waypoint/)).toBeVisible();
    await expect(
      inspector.getByRole('button', { name: 'Login stays synchronous', exact: true }),
    ).toBeVisible();
  });

  test('the neighbourhood lens draws typed React Flow cards around the node', async ({ page }) => {
    await signIn(page, `#focus/${state.srcId}`);
    await expect(page.getByRole('tab', { name: 'Neighbourhood' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const nodes = page.locator('.react-flow__node');
    await expect(nodes.first()).toBeVisible();
    expect(await nodes.count()).toBeGreaterThan(1);
    await expect(page.locator('.ncard[data-center="true"]')).toContainText('login');
    await expect(page.locator('.edge-label').first()).toBeVisible();
  });

  test('the impact lens shows dependents or says there are none', async ({ page }) => {
    await signIn(page, `#impact/${state.srcId}`);
    await expect(page.getByRole('group', { name: 'Impact view' })).toBeVisible();
    await expect(page.locator('.ncard[data-center="true"], .state h2').first()).toBeVisible();
    await page.getByRole('button', { name: 'Critical path' }).click();
    await expect(page.locator('.ncard, .state h2').first()).toBeVisible();
  });

  test('review: accept with the keyboard, then undo from the toast', async ({ page }) => {
    await signIn(page, `#review/${state.pendingId3}`);
    const option = page.locator(`[data-pid="${state.pendingId3}"]`);
    await expect(option).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('region', { name: 'Proposal', exact: true })).toContainText(
      'e2e seed — reviewed in the map UI',
    );
    await expect(page.getByRole('link', { name: /example\.org\/auth-notes/ })).toBeVisible();
    await expect(page.locator('.react-flow__edge').first()).toBeAttached();

    await page.getByRole('listbox', { name: 'Proposals' }).focus();
    await page.keyboard.press('a');
    await expect(page.getByText('Link accepted')).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get('/api/pending-edges')).json()) as {
              id: number;
              status: string;
            }[]
          ).find((p) => p.id === state.pendingId3)?.status,
      )
      .toBeUndefined(); // /api/pending-edges lists open proposals only

    await page.locator('.toast').getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByText('Undone')).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get('/api/pending-edges')).json()) as {
              id: number;
              status: string;
            }[]
          ).find((p) => p.id === state.pendingId3)?.status,
      )
      .toBe('pending');
    await expect(page.locator(`[data-pid="${state.pendingId3}"]`)).toBeVisible();
  });

  test('waypoints: the seeded chain renders, and a live drop appears with a toast', async ({
    page,
  }) => {
    await signIn(page, `#waypoints/${state.waypointId}`);
    await expect(page.getByRole('heading', { name: 'Login stays synchronous' })).toBeVisible();
    await expect(page.locator('.wcard')).toContainText('Login stays synchronous');
    await expect(page.locator('.ncard')).toContainText('login');

    write('waypoint', 'Live waypoint from e2e', state.dstId);
    await expect(page.locator('.toast').getByText('Waypoint: Live waypoint from e2e')).toBeVisible({
      timeout: 5000,
    });
    const item = page.getByRole('option', { name: /Live waypoint from e2e/ });
    await expect(item).toBeVisible();
    await expect(item.getByText('new')).toBeVisible();
  });

  test('a note an agent leaves shows up live in the open inspector', async ({ page }) => {
    await signIn(page, `#${state.logoutId}`);
    const inspector = page.getByTestId('inspector');
    await expect(inspector.getByRole('heading', { name: 'logout' })).toBeVisible();
    write('note', state.logoutId, 'Live note from e2e');
    await expect(page.locator('.toast').getByText('Your agent left a note')).toBeVisible({
      timeout: 5000,
    });
    await expect(inspector).toContainText('Live note from e2e');
  });

  test('overview: the orientation map, orphans and recent writes', async ({ page }) => {
    await signIn(page, '#overview');
    await expect(
      page.getByRole('article', { name: 'Orientation map' }).getByRole('heading', { level: 1 }),
    ).toContainText('Repository overview');
    await expect(page.getByText('Orphaned memory').first()).toBeVisible();
    await expect(page.getByText('Recent writes')).toBeVisible();
  });

  test('keyboard: the list view is a table you can walk and open', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'List view' }).click();
    const rows = page.getByRole('table', { name: 'Nodes in the map' }).locator('tbody tr');
    await rows.first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toBeFocused();
    const name = (await rows.nth(1).locator('td').first().innerText()).trim();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('inspector').getByRole('heading', { name })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inspector')).toHaveCount(0);
  });

  test('a failed graph load shows what failed and a retry', async ({ page }) => {
    await page.goto(state.loginUrl);
    await page.route('**/api/graph**', (r) =>
      r.fulfill({
        status: 500,
        contentType: 'application/json',
        body: '{"error":"database is locked"}',
      }),
    );
    await page.reload();
    await expect(page.getByRole('heading', { name: "Couldn't load the graph" })).toBeVisible();
    await expect(page.getByText('database is locked')).toBeVisible();
    await page.unroute('**/api/graph**');
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('application', { name: /Constellation/ })).toBeVisible();
  });

  test("the Blueprint lens draws the plan or says why it can't", async ({ page }) => {
    await page.goto(state.loginUrl);
    await page.getByRole('tab', { name: /Blueprint/ }).click();
    await expect(
      page
        .locator('.bp-node')
        .first()
        .or(page.getByRole('heading', { name: 'No packages to draw' })),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Copy Mermaid/ })).toBeVisible();
  });

  test('settings: Daylight applies at once and survives a reload', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Theme settings' }).click();
    await page.getByRole('menuitemradio', { name: 'Daylight' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // Put it back for the other specs.
    await page.request.put('/api/config', { data: { theme: 'system' } });
  });

  test('at 390px: bottom tab bar, a details sheet, and no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page, `#${state.srcId}`);
    const rail = page.getByRole('navigation', { name: 'Views' });
    const box = await rail.boundingBox();
    expect(box && box.y > 700).toBe(true);
    await expect(
      page.getByTestId('inspector').getByRole('heading', { name: 'login' }),
    ).toBeVisible();
    for (const hash of ['', '#review', '#waypoints', '#overview']) {
      await page.goto(`${state.url}/${hash}`);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `no horizontal scroll at ${hash || 'map'}`).toBeLessThanOrEqual(0);
    }
  });
});
