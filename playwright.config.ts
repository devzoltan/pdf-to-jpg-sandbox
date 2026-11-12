import { defineConfig, devices } from '@playwright/test';

const PORT = 8091;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    acceptDownloads: true,
    ...devices['Desktop Chrome'],
  },
  // Real server from the build, with an image rebuild before every job (default behaviour)
  webServer: {
    command: 'node dist/server/index.js',
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
