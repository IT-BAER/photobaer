import { defineConfig, devices } from '@playwright/test';

// Serves the production build; run `pnpm build` first (`pnpm test:e2e` does both).
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: { command: 'pnpm exec vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true },
  // WebGPU needs a visible window: headless Firefox has no adapter, so run `--headed` to cover it.
  // The latency probe runs after every other test and one browser at a time: a neighbouring test inflates its p95.
  projects: [
    { name: 'firefox', use: devices['Desktop Firefox'], testIgnore: /paint-perf/ },
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testIgnore: /paint-perf/ },
    { name: 'perf-firefox', use: devices['Desktop Firefox'], testMatch: /paint-perf/, dependencies: ['firefox', 'chrome'] },
    { name: 'perf-chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' }, testMatch: /paint-perf/, dependencies: ['perf-firefox'] },
  ],
});
