import { defineConfig } from 'vitest/config';
export default defineConfig({
  // Vite injects the build info in the web app; unit tests get a fixed stand-in.
  define: {
    __APP_BUILD__: JSON.stringify({ version: '0.0.0+test', builtAt: '2026-01-01T00:00:00.000Z' }),
  },
  test: { include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'], testTimeout: 15000 },
});
