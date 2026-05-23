import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 7475);

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `bun run e2e/seed-and-serve.ts`,
    url: `http://127.0.0.1:${PORT}/api/status`,
    env: { E2E_PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
