import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

// Render the existing vector logo rather than maintaining separate artwork.
const publicDir = new URL('../apps/web/public/', import.meta.url);
const logo = await readFile(new URL('favicon.svg', publicDir), 'utf8');
const background = '<rect width="64" height="64" fill="#527866"/>';
const foreground = logo.replace(/<rect\b[^>]*\/>/, '');
// Android uses the alpha mask for its small notification icon. Keep the
// app's check and dot, with no background and a single foreground color.
const notificationBadge = foreground.replace('fill="#dce8a1"', 'fill="#fff"');
const opaqueLogo = logo.replace(/<rect\b[^>]*\/>/, background);
// Android crops maskable icons. Keep the check and dot inside the central
// safe circle (radius 40% of the image) and fill the entire canvas with green.
const maskableLogo = foreground
  .replace(/(<svg\b[^>]*>)/, `$1${background}<g transform="translate(9.6 9.6) scale(.7)">`)
  .replace('</svg>', '</g></svg>');

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
});
try {
  for (const [filename, size, svg] of [
    ['pwa-192.png', 192, logo],
    ['pwa-512.png', 512, logo],
    ['pwa-maskable.png', 512, maskableLogo],
    ['notification-badge.png', 96, notificationBadge],
    ['apple-touch-icon.png', 180, opaqueLogo],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(
      `<style>html,body{margin:0}svg{display:block;width:100vw;height:100vh}</style>${svg}`,
    );
    await page.screenshot({
      path: fileURLToPath(new URL(filename, publicDir)),
      omitBackground: true,
    });
    await page.close();
  }
} finally {
  await browser.close();
}
