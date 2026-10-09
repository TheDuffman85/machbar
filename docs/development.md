# Development

[← README](../README.md)

Requirements: Node.js **24.x** and PNPM **11.17.0** (pinned through `packageManager`).

```bash
corepack enable
pnpm install
pnpm --filter @machbar/shared build
pnpm --filter @machbar/api build
pnpm dev
```

Open **http://localhost:5173**, or **http://<server-ip>:5173** from another device, and create a profile. Vite binds to all network interfaces and proxies API requests to port 3000. Shared TypeScript builds in watch mode. The API loads the root `.env` if present and honors `APP_URL`. For a custom development hostname, set `APP_URL` to the browser-facing origin, including port 5173; Vite allows that hostname automatically. Restart development processes after changing environment variables. Remote PWA installation and offline support require HTTPS; ordinary checkoffs work over LAN HTTP.

For a production build without Docker:

```bash
pnpm build
NODE_ENV=production pnpm start
```

`APP_URL` defaults to `http://localhost:3000`. For Docker configuration, see the [README](../README.md#configuration). Optional local server variables: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (`./data`), and `WEB_DIR` (`./apps/web/dist`). `DISABLE_USER_CREATION` defaults to `false`, allowing visitors to create profiles. Set it to `true` to require an existing saved user ID or its QR code; existing profiles can still edit and sync their data. Both bootstrap and sync enforce this restriction on the server, even when the data directory is empty.

Settings shows the installed frontend version and build date. Every Vite build (including Docker builds) appends a UTC timestamp with millisecond precision to the root package version, for example `1.0.0+20261006120000123`. The build date uses the selected language and timezone. Both values are embedded in the frontend, so they stay accurate offline and change when a new build is installed. Development generates them when Vite starts.

## Workspace

- `apps/web`: React, Vite, Tailwind, React Router, TanStack Query, i18next, IndexedDB, and a custom Workbox service worker.
- `apps/api`: Fastify, browser UUID profiles, HTTP validation, and transactional SQLite persistence using Node’s built-in `node:sqlite`.
- `packages/shared`: Zod schemas, calendar rules, completion operations, and pure progression calculations.

Server data lives in `DATA_DIR/data.db`. SQLite schema version 4 uses relational tables for profiles, avatar options, habits, schedule history and weekdays, goals and steps, gifts, completions, operation receipts, push subscriptions, and dispatch receipts. Profile relationships use composite foreign keys containing the user ID; ordered collections retain explicit positions. API documents remain schema version 1 and are reconstructed within a read transaction. Writes replace the profile or push state atomically, with cached logical payload byte counts updated in the same transaction for quota accounting. No complete JSON document is stored in SQLite.

Startup automatically upgrades the previous SQLite `records` table or imports legacy JSON files, committing the normalized schema and data together. JSON originals move into `DATA_DIR/migration-backup`, which is created when needed. See [SQLite upgrades and rollback](deployment.md#sqlite-upgrades-and-rollback) before upgrading an existing data directory.

## Verification

```bash
pnpm check
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm test:docker
docker compose config --quiet
docker compose up -d --build
curl http://localhost:3000/health
```

Browser tests exercise the production build on an isolated temporary data directory at port 3100. They cover desktop/mobile layouts, accessibility, all offline feature mutations, offline reload and synchronization, automatic conflicts, API outages, interrupted requests, cache upgrades, multiple tabs, and account switching. The `iphone` project uses WebKit with iPhone 17 Pro Max emulation to check mobile form sizing and menu navigation. An existing Chromium executable can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Production does not contain the test reset or seed routes.

Docker tests build an isolated image and verify closed public registration, local profile provisioning, automatic JSON-to-SQLite migration and permission repair with existing root-owned profiles, a real API sync, the application's UID/GID and lack of effective capabilities, direct non-root startup, custom data directories, symlink preservation, and unwritable-mount errors. They require a local Linux Docker daemon without user namespace remapping and do not publish ports or use your application data.
