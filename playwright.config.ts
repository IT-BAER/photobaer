import { defineConfig, devices } from '@playwright/test';

// Serves the production build; run `pnpm build` first (`pnpm test:e2e` does both).
export default defineConfig({
  testDir: 'tests/e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: { command: 'pnpm exec vite preview --port 4173 --strictPort', url: 'http://localhost:4173', reuseExistingServer: true },
  // WebGPU needs a visible window: headless Firefox has no adapter, so run `--headed` to cover it.
  projects: [
    { name: 'firefox', use: devices['Desktop Firefox'] },
    { name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
  ],
});
