import { expect, test } from '@playwright/test';
import { readState } from './_state.ts';

const state = readState();

// Subscribe to /ws inside the page context and collect events into window.__events.
const installWsCollector = async (page: import('@playwright/test').Page): Promise<void> => {
  await page.evaluate((wsUrl) => {
    interface E2EWin extends Window { __events?: unknown[] }
    const w = window as E2EWin;
    w.__events = [];
    const ws = new WebSocket(wsUrl);
    ws.onmessage = (m) => {
      try {
        w.__events!.push(JSON.parse(m.data));
      } catch {
        /* ignore */
      }
    };
    // Best-effort: wait for open before resolving.
    return new Promise<void>((res) => {
      ws.onopen = () => res();
      setTimeout(res, 500);
    });
  }, state.url.replace(/^http/, 'ws') + '/ws');
};

const eventsOfType = async (page: import('@playwright/test').Page, type: string) =>
  page.evaluate(
    (t) => (window as unknown as { __events?: { type: string }[] }).__events?.filter((e) => e.type === t) ?? [],
    type,
  );

test('propose → accept → undo flow drives WS events into the page', async ({ page }) => {
  await page.goto('/');
  await installWsCollector(page);

  // The /api/graph endpoint should include the pending edge.
  const graph = await (await page.request.get('/api/graph')).json();
  const pending = (graph.pending_edges ?? []).find((p: { id: number }) => p.id === state.pendingId);
  expect(pending).toBeDefined();
  expect(pending.src).toBe(state.srcId);
  expect(pending.dst).toBe(state.dstId);

  // Accept via REST → expect edge:accepted WS event delivered to the page.
  const acceptRes = await page.request.post(`/api/pending-edges/${state.pendingId}/accept`);
  expect(acceptRes.ok()).toBe(true);
  await expect
    .poll(async () => (await eventsOfType(page, 'edge:accepted')).length, { timeout: 2000 })
    .toBeGreaterThan(0);

  // Undo via REST → expect any post-undo broadcast (edge:added reversion or edge:rejected).
  const undoRes = await page.request.post('/api/undo');
  expect(undoRes.ok()).toBe(true);
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(
          () => (window as unknown as { __events?: { type: string }[] }).__events ?? [],
        );
        return all.length;
      },
      { timeout: 2000 },
    )
    .toBeGreaterThan(1);
});
