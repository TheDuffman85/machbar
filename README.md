# Machbar

**Small wins. Every day.** A self-hosted, mobile-first PWA for habits, goals, and gifts to yourself.

Machbar turns daily habits and larger goals into checkable challenges. Each small win earns 10 XP; every 100 XP advances a level. Achievement badges and habit streaks celebrate consistency. Attach a gift to a completed goal, habit completion count, or best streak, and record when you treat yourself.

## Run with Docker Compose

Requirements: Docker and Docker Compose. The image uses Node.js 24 LTS.

```bash
cp .env.example .env
docker compose up -d --build
```

Open **http://localhost:3000**. Configure your name, language, timezone, and avatar, then add your first habit or goal. Data lives in the persistent `machbar_data` volume. The container runs as an unprivileged user, has a read-only application filesystem, and exposes `/health` for health checks.

By default the port binds to all network interfaces. Other devices can open `http://<server-ip>:3000`; the app accepts same-origin writes through that address. Set `BIND_ADDRESS=127.0.0.1` to limit access to the host. For a public deployment, place an HTTPS reverse proxy in front of the app and set `APP_URL=https://machbar.example.com`. Service workers require HTTPS, except on localhost.

Run **one application instance** against the data volume. JSON writes are serialized per user and saved through flush and atomic rename; this is not a shared-filesystem cluster or a horizontally scalable service.

## Browser profiles

There is no login. Each browser receives a unique UUID stored in local storage (`machbar-user-id`), with its profile saved in a separate `<userId>.json` file on the server. Open **Switch User** from the avatar menu to see and copy your ID or QR code. On another device, enter that existing ID, scan its QR code with the camera, or upload a QR image, then choose **Switch profile**. Camera scanning requires HTTPS or localhost; manual entry and QR image upload also work on LAN HTTP. Sync or discard pending changes before switching. Your previous profile stays saved.

Keep your ID or QR code somewhere safe: clearing browser storage creates a new ID, and anyone who knows an ID can access and edit that profile. The ID is an access key, not a login.

The data directory is never exposed by the web server.

## Development

Requirements: Node.js **24.x** and PNPM **11.17.0** (pinned through `packageManager`).

```bash
corepack enable
pnpm install
pnpm dev
```

Open **http://localhost:5173**, or **http://<server-ip>:5173** from another device. Vite binds to all network interfaces and proxies API requests to port 3000. Shared TypeScript builds in watch mode. The API loads the root `.env` if present and honors `APP_URL`. For a custom development hostname, set `APP_URL` to the browser-facing origin, including port 5173; Vite allows that hostname automatically. Restart development processes after changing environment variables. Remote PWA installation and offline support require HTTPS; ordinary checkoffs work over LAN HTTP.

For a production build without Docker:

```bash
pnpm build
NODE_ENV=production pnpm start
```

`APP_URL` defaults to `http://localhost:3000`. Optional server variables: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (`./data`), and `WEB_DIR` (`./apps/web/dist`). Relative data/web paths resolve from the repository root so development and production share the same local data directory.

### Workspace

- `apps/web`: React, Vite, Tailwind, React Router, TanStack Query, i18next, IndexedDB, and a custom Workbox service worker.
- `apps/api`: Fastify, browser UUID profiles, HTTP validation, and atomic JSON persistence.
- `packages/shared`: Zod schemas, calendar rules, completion operations, and pure progression calculations.

## Daily rules and offline behavior

- Habits repeat daily or on selected weekdays. Streaks count consecutive scheduled occurrences; unscheduled days do not break them. An unfinished occurrence today remains open until the day ends.
- Today shows each habit's current streak and the selected date. Opening the page always starts on today. Use the day arrows to fill in missed checkoffs on dates when the habit was scheduled, up to **3 days before today** by default. Set `DAILY_HISTORY_DAYS` in the environment or root `.env` to a non-negative integer to change this limit (`0` allows today only), then restart the server or recreate the Compose container; no rebuild is needed. XP and streaks update automatically. Past checkoffs also work offline with the last cached limit.
- Habit schedule edits take effect tomorrow. Schedule history retains earlier weekdays and timezones. Dates use IANA timezones, not the server's local clock.
- Goal steps may be undated or have a date. Today shows due and overdue steps; undated steps remain in Goals. An empty goal does not complete.
- Undo recalculates XP, levels, streaks, badges, and unclaimed gifts. Claimed gifts remain in history. Archiving retains completion records and earned XP.
- After the first connected visit, install the app through your browser. On iOS use **Share → Add to Home Screen**.
- After the first connected profile visit, every feature except switching profiles works offline: create/edit/archive habits, goals, steps and gifts, reorder steps, check off or undo tasks, claim gifts, and save settings or avatars. Changes are committed to IndexedDB before the UI confirms success and survive reloads. Onboarding can finish offline once the initial profile has loaded. A new profile cannot initialize without that first connection.
- Local changes, reconnection, foreground focus, app launch, and manual retry trigger background synchronization. Cached startup and local saves never wait for API availability. Requests time out after 10 seconds; transient failures retry with backoff. Background Sync support is not required. Retries are idempotent, and duplicate wins earn XP once.
- Browser-ID switches keep local documents, sync baselines, and pending changes scoped to their original ID. Pending changes are never replayed into another account. IndexedDB transactions coordinate local writes across tabs, with Web Locks additionally coordinating sync where available.
- Sync performs a three-way merge against the last synchronized document. Independent additions and edits to different fields combine; the server value wins when both devices edit the same field differently. Completed wins conflicting completion changes, including an undo versus a remote undo/recompletion. Ordinary undo still works when the server completion has not changed since the baseline. Archives and gift claims survive conflicts. Schedule entries merge by effective date, with the server winning ties; timezone conflicts keep the server calendar schedules together. Step ordering preserves additions, using server ordering when both sides reorder. Original completion dates and timezones are retained.
- Existing browser caches upgrade without clearing profiles or pending checkoffs. Unreplayable legacy operations remain saved for recovery; **Use server progress** explicitly discards pending local changes and reloads saved data.
- Updates are prompted and cannot be activated while changes are pending. Reduced-motion preferences disable decorative motion and celebrations.

Browser storage is a local cache, not a backup. Unsynced changes depend on that browser's IndexedDB storage remaining available.

## API contract

All `/api/*` routes use the browser UUID sent in `X-Machbar-User`. Only UUIDs are accepted. The backend manages profile identity, validates synchronized documents, and persists them atomically; task rules and all derived progress run in the client.

| Route                  | Purpose                                              |
| ---------------------- | ---------------------------------------------------- |
| `GET /api/bootstrap`   | Stored user document and daily-history configuration |
| `POST /api/local-user` | Load an existing browser profile (`{ userId }`)      |
| `PUT /api/sync`        | Save a complete merged `UserDocument`                |
| `GET /health`          | Process health                                       |

Bootstrap, profile switching, and sync return `{ document, dailyHistoryDays }`. The client calculates today, XP, levels, streaks, achievements, goal progress, gift availability, and plant growth.

Sync sends `If-Match: <server revision>`, `X-Machbar-User: <userId>`, a same-origin `Origin`, and the complete document as JSON. Its `userId` and `revision` must match the identity header and expected revision. The server saves only if its current revision matches, then increments the revision. On `DOCUMENT_CONFLICT`, the client fetches the latest document, merges again, and retries. Failed or interrupted requests leave local pending changes intact. An acknowledgment clears only the captured batch; changes made during a request remain pending and are rebased onto the saved document. Sync accepts documents up to 8 MiB.

The stored document remains schema version 1. It includes task IDs, schedule history, archive/claim timestamps, completion records and operation receipts. Completion identities are habit/date or goal-step ID; progress is derived from completed records, so retries do not award duplicate XP.

Errors return `{ "code": "STABLE_ERROR_CODE" }`. Common codes include `VALIDATION_ERROR`/`INVALID_IDENTITY` (400), `ORIGIN_REJECTED` (403), `NOT_FOUND`/`USER_NOT_FOUND` (404), `DOCUMENT_CONFLICT`/`ACCOUNT_CHANGED` (409), `REVISION_REQUIRED` (428), and `DATA_CORRUPT` (500). UI messages are translated.

Deploy the client and API together: the old feature-specific mutation endpoints have been removed. When upgrading from the completion-only client, close all open Machbar tabs/windows and reopen the app so its waiting service worker can activate and migrate the local cache, including unsynced checkoffs. Browser data must remain intact during the upgrade.

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

Browser tests exercise the production build on an isolated temporary data directory at port 3100. They cover desktop/mobile layouts, accessibility, all offline feature mutations, offline reload and synchronization, automatic conflicts, API outages, interrupted requests, cache upgrades, multiple tabs, and account switching. An existing Chromium executable can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Production does not contain the test reset or seed routes.

## Plant growth

The Today plant grows into a rounded bush in 24-level branches: six levels add one leaf each, then the next eighteen add one blossom petal each, completing three six-petal blossoms. Petal levels do not add normal leaves. Once a branch is full, the next level begins a new branch spreading outward and upward through the crown. Blossoms sit over the foliage, and the whole plant zooms out uniformly as the bush fills out. Growth respects the device's reduced-motion setting.

## Credits

Choose **Edit avatar** in Settings to customize skin tone, hair, facial features, clothing, accessories, and background in a live preview. Randomize a look or reset your changes, then save the avatar. During onboarding, the avatar is saved when you finish your profile. Existing robot avatars remain until you save a custom portrait.

Icons: [Lucide](https://lucide.dev/license). Avatars: [DiceBear](https://www.dicebear.com/) with Pablo Stanley's [Bottts](https://bottts.com/) and [Avataaars](https://avataaars.com/) artwork, generated locally without a hosted avatar API. See `apps/web/public/credits.txt` and the Settings page for license notices.
