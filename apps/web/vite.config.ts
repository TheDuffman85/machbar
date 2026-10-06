import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('../../', import.meta.url)), '');
  const appUrl = process.env.APP_URL ?? env.APP_URL;
  const { version } = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  const builtAt = new Date().toISOString();
  return {
    define: {
      __APP_BUILD__: JSON.stringify({
        version: `${version}+${builtAt.replace(/\D/g, '')}`,
        builtAt,
      }),
    },
    plugins: [
      react(),
      tailwindcss(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
        manifest: {
          name: 'Machbar — Small wins. Every day.',
          short_name: 'Machbar',
          description: 'Small wins. Every day.',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          background_color: '#f7f8f5',
          theme_color: '#f7f8f5',
          icons: [
            { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,png,svg,woff2,txt}'],
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        },
      }),
    ],
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: appUrl ? [new URL(appUrl).hostname] : [],
      proxy: {
        '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
        '/health': { target: 'http://127.0.0.1:3000', changeOrigin: false },
      },
    },
  };
});
