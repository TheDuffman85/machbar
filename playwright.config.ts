import { defineConfig, devices } from '@playwright/test';

const chromiumLaunchOptions = {
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  args: ['--host-resolver-rules=MAP machbar.test 127.0.0.1'],
};

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 8000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'en-US',
  },
  projects: [
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 1000 },
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        defaultBrowserType: 'chromium',
        launchOptions: chromiumLaunchOptions,
      },
    },
    {
      name: 'iphone',
      testMatch: /(?:mobile-safari|pwa-identity)\.spec\.ts/,
      use: { ...devices['iPhone 17 Pro Max'] },
    },
  ],
  webServer: {
    command: 'pnpm build && node tests/server.mjs',
    url: 'http://localhost:3100/health',
    timeout: 120000,
    reuseExistingServer: false,
  },
});
