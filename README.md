# Machbar

**Small wins. Every day.** A self-hosted, mobile-first PWA for habits, goals, and gifts to yourself.

Machbar turns daily habits and larger goals into checkable challenges. Each small win earns 10 XP; every 100 XP advances a level. Achievement badges and habit streaks celebrate consistency. Attach a gift to a completed goal, habit completion count, or best streak, and record when you treat yourself.

## Run with Docker Compose

Requirements: Docker and Docker Compose. The image uses Node.js 24 LTS.

```bash
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
# Paste the generated value into SESSION_SECRET in .env.
docker compose up -d --build
```

Open **http://localhost:3000**. Configure your name, language, timezone, and avatar, then add your first habit or goal. Data lives in the persistent `machbar_data` volume. The container runs as an unprivileged user, has a read-only application filesystem, and exposes `/health` for health checks.

By default the port binds to all network interfaces. Other devices can open `http://<server-ip>:3000`; single-user mode accepts same-origin writes through that address. Set `BIND_ADDRESS=127.0.0.1` to limit access to the host. For a public deployment, place an HTTPS reverse proxy in front of the app and set `APP_URL=https://machbar.example.com`. OIDC uses this canonical origin for login and mutations. Service workers require HTTPS, except on localhost.

Run **one application instance** against the data volume. JSON writes are serialized per user and saved through flush and atomic rename; this is not a shared-filesystem cluster or a horizontally scalable service.

## Authentication

With all OIDC variables empty, there is no login and everyone visiting this instance shares one profile. Enable OIDC for separate personal accounts:

```dotenv
APP_URL=https://machbar.example.com
SESSION_SECRET=<random value of at least 32 characters>
OIDC_ISSUER_URL=https://identity.example.com/realms/personal
OIDC_CLIENT_ID=machbar
OIDC_CLIENT_SECRET=<provider client secret>
```

Register **`https://machbar.example.com/auth/callback`** as the redirect URI at the provider. Use a confidential web client with Authorization Code flow, PKCE S256, and the `openid profile` scopes. Discovery and issuer endpoints must use HTTPS. Configure all three OIDC variables together; partial configuration fails startup. OIDC configuration has no settings-page controls.

Sessions last seven days. Login transactions expire after ten minutes and are single-use. OIDC state, nonce, PKCE, issuer, signatures, and token claims are verified; provider tokens are not persisted. Logout clears the app session and local account cache. Provider-wide single logout is outside this version.

Each account is mapped from `(issuer, subject)` to a SHA-256 filename. The data directory is never exposed by the web server. Enabling OIDC does not automatically transfer the original local profile into a new account.

## Development

Requirements: Node.js **24.x** and PNPM **11.17.0** (pinned through `packageManager`).

```bash
corepack enable
pnpm install
pnpm dev
```

Open **http://localhost:5173**, or **http://<server-ip>:5173** from another device. Vite binds to all network interfaces and proxies API/auth requests to port 3000. Shared TypeScript builds in watch mode. The API loads the root `.env` if present and honors `APP_URL`. For a custom development hostname or OIDC, set `APP_URL` to the browser-facing origin, including port 5173; Vite allows that hostname automatically. Restart development processes after changing environment variables. Remote PWA installation and offline support require HTTPS; ordinary checkoffs work over LAN HTTP.

For a production build without Docker:

```bash
pnpm build
NODE_ENV=production pnpm start
```

Set `SESSION_SECRET` in the environment or root `.env` first. `APP_URL` defaults to `http://localhost:3000`. Optional server variables: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (`./data`), and `WEB_DIR` (`./apps/web/dist`). Relative data/web paths resolve from the repository root so development and production share the same local data directory.

### Workspace

- `apps/web`: React, Vite, Tailwind, React Router, TanStack Query, i18next, IndexedDB, and a custom Workbox service worker.
- `apps/api`: Fastify, cookie sessions, OIDC, HTTP validation, and atomic JSON persistence.
- `packages/shared`: Zod schemas, calendar rules, completion operations, and pure progression calculations.

## Daily rules and offline behavior

- Habits repeat daily or on selected weekdays. Streaks count consecutive scheduled occurrences; unscheduled days do not break them. An unfinished occurrence today remains open until the day ends.
- Habit schedule edits take effect tomorrow. Schedule history retains earlier weekdays and timezones. Dates use IANA timezones, not the server's local clock.
- Goal steps may be undated or have a date. Today shows due and overdue steps; undated steps remain in Goals. An empty goal does not complete.
- Undo recalculates XP, levels, streaks, badges, and unclaimed gifts. Claimed gifts remain in history. Archiving retains completion records and earned XP.
- After the first connected visit, install the app through your browser. On iOS use **Share → Add to Home Screen**.
- Offline mode supports viewing saved data and completing/unchecking cached challenges. Pending changes are labeled and survive reloads. Creating/editing tasks, settings changes, and claiming gifts require a connection.
- Reconnection, foreground focus, and app launch trigger synchronization. Background Sync support is not required. Retries are idempotent, and duplicate wins earn XP once.
- An expired session pauses sync until login. An account change clears the previous local account cache and never replays its pending changes into another account.
- A conflicting undo pauses the queue. Choose **Use server progress** to discard local pending checkoffs, review the latest state, and retry manually. The original date is preserved when delayed habit checkoffs sync.
- Updates are prompted and cannot be activated while changes are pending. Reduced-motion preferences disable decorative motion and celebrations.

Browser storage is a local cache, not a backup. Unsynced changes depend on that browser's IndexedDB storage remaining available.

## API contract

All `/api/*` routes use the current session, or the shared `local` identity in single-user mode. Fetch `/api/bootstrap` for the account document, derived progress, auth mode, and current date.

Task/preferences/gift mutations send `If-Match: <document revision>`, `X-Machbar-User: <userId>`, and the canonical `Origin`. Revisions prevent silent overwrites; the identity header prevents account-switch races. Completion operations use their own occurrence version instead of a document revision.

| Routes                                                                           | Purpose                                  |
| -------------------------------------------------------------------------------- | ---------------------------------------- |
| `GET /api/bootstrap`                                                             | Current user, document, and progress     |
| `PATCH /api/preferences`                                                         | Profile, locale, timezone, theme, avatar |
| `POST /api/habits`, `PATCH /api/habits/:id`                                      | Create/edit a habit                      |
| `POST /api/goals`, `PATCH /api/goals/:id`                                        | Create/edit a goal                       |
| `POST /api/goals/:id/steps`, `PATCH /api/steps/:id`                              | Create/edit a step                       |
| `PUT /api/goals/:id/order`                                                       | Complete ordered array of step IDs       |
| `DELETE /api/{habits,goals,steps,gifts}/:id`                                     | Archive an item                          |
| `POST /api/completions`                                                          | Complete or undo a habit occurrence/step |
| `POST /api/gifts`, `POST /api/gifts/:id/claim`                                   | Create/claim a gift                      |
| `GET /auth/config`, `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Authentication                           |
| `GET /health`                                                                    | Process health                           |

A completion operation has `operationId` (UUID), `targetType` (`habit`/`step`), `targetId`, `date` (`YYYY-MM-DD`), `timezone`, `completed`, and `expectedVersion`. A habit occurrence is identified by habit/date; a goal step has one completion identity. The server derives awards and rejects extra fields.

Errors return `{ "code": "STABLE_ERROR_CODE" }`. Common codes include `VALIDATION_ERROR` (400), `AUTH_REQUIRED` (401), `ORIGIN_REJECTED` (403), `NOT_FOUND` (404), `DOCUMENT_CONFLICT`/`COMPLETION_CONFLICT`/`ACCOUNT_CHANGED` (409), `REVISION_REQUIRED` (428), and `DATA_CORRUPT` (500). UI messages are translated.

## Backup and restore

Stop the app before copying JSON files for a consistent backup:

```bash
docker compose stop machbar
mkdir -p backups
docker compose cp machbar:/app/data ./backups/machbar-data
docker compose start machbar
```

Keep backups private: they contain profile and task history. Save deployment configuration separately. To restore, stop the app, copy the backed-up JSON files into the volume, and preserve ownership for UID/GID **1000** and mode **0600**. One way to perform maintenance is a temporary Compose container:

```bash
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/backups/machbar-data:/backup:ro" machbar \
  -c 'cp /backup/*.json /app/data/ && chown 1000:1000 /app/data/*.json && chmod 600 /app/data/*.json'
docker compose start machbar
```

This overwrites matching user files; restore into a fresh volume if you need an exact snapshot. Corrupt or unsupported documents produce `DATA_CORRUPT` rather than being replaced with blank data. Schema version 1 is the initial format; future changes require explicit migrations.

## Verification

```bash
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
docker compose config --quiet
docker compose up -d --build
curl http://localhost:3000/health
```

Browser tests exercise the production build on isolated temporary data directories at ports 3100/3101, with a test-only mock identity provider. They cover desktop/mobile layouts, accessibility, offline reload and synchronization, conflicts, and account switching. An existing Chromium executable can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Production does not contain the test reset or mock identity routes.

## Credits

Icons: [Lucide](https://lucide.dev/license). Avatars: [DiceBear](https://www.dicebear.com/) with Pablo Stanley's [Bottts](https://bottts.com/) artwork, generated locally without a hosted avatar API. See `apps/web/public/credits.txt` and the Settings page for license notices.
