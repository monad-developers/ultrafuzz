import { defineConfig } from '@playwright/test';

const smokePort = Number(process.env.ULTRAFUZZ_DASHBOARD_SMOKE_PORT ?? 4875);
const baseURL = `http://127.0.0.1:${smokePort}`;

export default defineConfig({
  testDir: './tests/smoke',
  timeout: 60_000,
  expect: {
    timeout: 10_000
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: 'retain-on-failure'
  },
  webServer: {
    command: `node scripts/start-dashboard-smoke.mjs ${smokePort}`,
    url: `${baseURL}/dashboard`,
    reuseExistingServer: false,
    timeout: 240_000
  }
});
