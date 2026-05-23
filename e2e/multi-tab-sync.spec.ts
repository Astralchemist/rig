import { expect, test } from '@playwright/test';
import { readState } from './_state.ts';

const state = readState();

const installWsCollector = async (page: import('@playwright/test').Page, wsUrl: string): Promise<void> => {
  await page.evaluate((url) => {
    interface E2EWin extends Window { __events?: unknown[] }
    const w = window as E2EWin;
    w.__events = [];
    const ws = new WebSocket(url);
    ws.onmessage = (m) => {
      try {
        w.__events!.push(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    return new Promise<void>((res) => {
      ws.onopen = () => res();
      setTimeout(res, 500);
    });
  }, wsUrl);
};

const countEvents = (page: import('@playwright/test').Page, type: string) =>
  page.evaluate(
    (t) => (window as unknown as { __events?: { type: string }[] }).__events?.filter((e) => e.type === t).length ?? 0,
    type,
  );

test('mutation in tab A is visible in tab B within 1500ms', async ({ browser }) => {
  const wsUrl = state.url.replace(/^http/, 'ws') + '/ws';

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await pageA.goto(state.url);
  await pageB.goto(state.url);
  await installWsCollector(pageA, wsUrl);
  await installWsCollector(pageB, wsUrl);

  // Use the second seeded pending edge (the first is consumed by the
  // propose-accept-undo spec). Tests run sequentially (workers=1).
  const start = Date.now();
  const acceptRes = await pageA.request.post(`${state.url}/api/pending-edges/${state.pendingId2}/accept`);
  expect(acceptRes.ok()).toBe(true);

  await expect.poll(() => countEvents(pageA, 'edge:accepted'), { timeout: 1500 }).toBeGreaterThan(0);
  await expect.poll(() => countEvents(pageB, 'edge:accepted'), { timeout: 1500 }).toBeGreaterThan(0);
  const elapsed = Date.now() - start;
  expect(elapsed, 'broadcast to both tabs lands in under 1500ms').toBeLessThan(1500);

  await ctxA.close();
  await ctxB.close();
});
