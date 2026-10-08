# Machbar

**Small wins. Every day.** A self-hosted, mobile-first PWA for habits, goals, and gifts to yourself.

Machbar turns daily habits and larger goals into checkable challenges. Each small win earns 10 XP; every 100 XP advances a level. Achievement badges and habit streaks celebrate consistency. Attach a gift to a completed goal, habit completion count, or best streak, and record when you treat yourself.

## Run with Docker Compose

Requirements: Docker and Docker Compose. The image uses Node.js 24 LTS.

```bash
cp .env.example .env
docker compose up -d --build
```

Open **http://localhost:3000**. Configure your name, language, timezone, and avatar, then add your first habit or goal. Data lives in the persistent `machbar_data` volume. The entrypoint starts as root to prepare the data directory and existing JSON profile files, then replaces itself with the app running as the unprivileged `node` user (UID/GID **1000:1000**). Compose keeps the application filesystem read-only and exposes `/health` for health checks.

To store data in a host directory, replace the volume mapping with a bind mount, for example `/srv/data/machbar:/app/data`. On startup the image automatically repairs ownership and owner access for the mounted directory and its regular `*.json` files. This also fixes `EACCES: permission denied` errors during sync when Docker created the host directory as root. Repairs preserve existing JSON contents and skip symlinked profile files. Absolute `DATA_DIR` overrides are supported. A failed repair or an unwritable data directory stops startup with an explanatory error.

The Compose capabilities `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, and `SETGID` allow the startup repair and user switch; the app runs without effective capabilities after the switch. If you require a non-root container from its first instruction, pre-create the data directory with ownership **1000:1000**, give its owner directory read/write/search access and existing JSON files read/write access, set `user: '1000:1000'`, and remove `cap_add` while keeping `cap_drop: [ALL]`. This skips automatic ownership repair and still checks that the directory is writable. Non-root process execution is separate from [Docker's rootless daemon mode](https://docs.docker.com/engine/security/rootless/): with a rootless daemon or user namespaces, bind-mount ownership must use the daemon's mapped IDs.

By default the port binds to all network interfaces. Other devices can open `http://<server-ip>:3000`; the app accepts same-origin writes through that address. Set `BIND_ADDRESS=127.0.0.1` to limit access to the host. For a public deployment, place an HTTPS reverse proxy in front of the app and set `APP_URL=https://machbar.example.com`. Service workers require HTTPS, except on localhost.

Run **one application instance** against the data volume. JSON writes are serialized per user and saved through flush and atomic rename; this is not a shared-filesystem cluster or a horizontally scalable service.

## Optional habit notifications

In **Settings → Notifications**, enable notifications separately in each browser or installed PWA where you want reminders. Then edit a habit, turn on **Remind me about this habit**, and choose its time. Existing habits have reminders disabled. Times follow the habit’s active schedule timezone, including deferred timezone changes. Daily and weekday habits remind only on scheduled days; weekly, monthly, and multi-day habits remind daily while the current period remains unfinished. Archived and completed habits do not produce new reminders. The same profile can receive reminders on multiple opted-in devices (up to 32).

Background delivery uses standard Web Push. Android and compatible desktop browsers support it; on **iOS/iPadOS 16.4 or later**, add Machbar to the Home Screen and open the installed app to enable notifications. Ordinary iOS browser tabs cannot receive push notifications. HTTPS is required outside localhost. Delivery is best effort and may be delayed or restricted by the browser, operating system, battery settings, or Focus mode; it is not an exact alarm.

The server and device need internet access for delivery. Fully offline scheduled background reminders are not supported by this PWA. Reminder edits and checkoffs still save offline and apply to the server after synchronization. An offline completion, reminder change, or archive cannot reliably cancel an already queued message. Messages expire at the next local midnight; reconnecting earlier can deliver a delayed reminder. Server restarts catch up on due reminders from the current local day, without replaying earlier days. Notifications display the habit title and open Today when clicked.

To enable delivery on your self-hosted server, generate a matching VAPID key pair **once**:

```bash
pnpm --filter @machbar/api exec web-push generate-vapid-keys --json
```

For a Docker-only installation, generate keys using the built image:

```bash
docker compose run --rm --no-deps machbar node -e 'console.log(JSON.stringify(require("./api/node_modules/web-push").generateVAPIDKeys()))'
```

Copy the output into `.env`, together with a real contact address:

```dotenv
VAPID_PUBLIC_KEY=<publicKey>
VAPID_PRIVATE_KEY=<privateKey>
VAPID_SUBJECT=mailto:you@example.com
```

Restart the server or recreate the Compose container. Keep the key pair stable and the private key private; rotating keys requires re-enabling notifications on each device. All three values absent/empty disables server notification support. Incomplete configuration, invalid or mismatched keys, and invalid contact addresses fail startup. No Firebase account or Apple developer membership is needed. The server requires outbound HTTPS to browser push services, including Google, Mozilla, and Apple (`*.push.apple.com`); the site and API remain self-hosted.

Subscriptions and dispatch records are saved separately in `DATA_DIR/push-state.json` with owner-only permissions. Include this file in stopped-server backups, alongside the profile JSON files, and preserve the VAPID configuration. Successful dispatches and ambiguous delivery attempts are not replayed after restart; DNS/connection failures before delivery and explicit 429/5xx push-service failures retry with backoff until expiry, and 404/410 removes expired subscriptions. A crash between claiming a dispatch and sending it can miss that reminder. The Settings test button verifies the delivery path and allows one test per minute per device.

Disabling notifications immediately clears this device’s local opt-in, unsubscribes from browser push, and closes displayed reminders. If server cleanup is offline, it retries after reconnection. Switching profiles removes the old device binding; the new profile requires explicit opt-in. Browser permission itself remains under browser/device settings. After upgrading Machbar, install the offered update and reopen old tabs before enabling or editing reminders; no profile reset is required.

## Browser profiles

There is no login. Each browser receives a unique UUID stored in local storage (`machbar-user-id`), with its profile saved in a separate `<userId>.json` file on the server. Open **Switch User** from the avatar menu to see and copy your ID or QR code. On another device, enter that existing ID, scan its QR code with the camera, or upload a QR image, then choose **Switch profile**. Camera scanning requires HTTPS or localhost; manual entry and QR image upload also work on LAN HTTP. Sync or discard pending changes before switching. Your previous profile stays saved.

The ID is also backed up in a host-only cookie (`SameSite=Strict`, `Secure` on HTTPS). On iOS 17.2 and later, installing a Home Screen app copies cookies but not local storage, so the PWA restores the same ID from that cookie on first launch and loads its synced profile. Existing local storage takes precedence, and switching profiles updates both copies. Sync pending changes before installing. For a PWA installed before this backup was available, use **Switch User** inside the PWA to restore the ID shown in Safari.

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

`APP_URL` defaults to `http://localhost:3000`. Optional server variables: `PORT` (3000), `HOST` (0.0.0.0), `DATA_DIR` (`./data`), and `WEB_DIR` (`./apps/web/dist`). Set `DISABLE_USER_CREATION=true` to prevent new profiles from being created. Visitors must enter an existing saved user ID or scan its QR code; existing profiles can still edit and sync their data. Both bootstrap and sync enforce this restriction on the server. The default is `false`. Save at least one profile and keep its user ID before enabling this mode, then restart the server (or recreate the Docker Compose container).

Relative data/web paths resolve from the repository root so development and production share the same local data directory.

Settings shows the installed frontend version and build date. Every Vite build (including Docker builds) appends a UTC timestamp with millisecond precision to the root package version, for example `1.0.0+20261006120000123`. The build date uses the selected language and timezone. Both values are embedded in the frontend, so they stay accurate offline and change when a new build is installed. Development generates them when Vite starts.

### Workspace

- `apps/web`: React, Vite, Tailwind, React Router, TanStack Query, i18next, IndexedDB, and a custom Workbox service worker.
- `apps/api`: Fastify, browser UUID profiles, HTTP validation, and atomic JSON persistence.
- `packages/shared`: Zod schemas, calendar rules, completion operations, and pure progression calculations.

## Daily rules and offline behavior

- Habits repeat daily, on selected weekdays, weekly, monthly, or every **1–365 days/weeks/months**. Weekly periods start Monday; monthly periods start on the 1st. Custom intervals use a chosen start date (aligned to its containing Monday/month start for weeks/months). A habit created partway through a calendar period gets the remaining days as its first period. Future starts remain unavailable until their start date.
- Longer-period habits appear in a separate Today section and do not increase the daily target. Complete once anytime before the period ends: the checkoff stays checked throughout that period and earns **10 XP once**. Streaks count consecutive successful occurrences; an unfinished current period stays open, and a missed finished period breaks the streak. Daily XP is shown on the original completion date.
- Today shows each habit's current streak and the selected date. Opening the page always starts on today. Use the day arrows to fill in missed checkoffs on dates when the habit was scheduled, up to **3 days before today** by default. Set `DAILY_HISTORY_DAYS` in the environment or root `.env` to a non-negative integer to change this limit (`0` allows today only), then restart the server or recreate the Compose container; no rebuild is needed. XP and streaks update automatically. Past checkoffs also work offline with the last cached limit.
- Habit interval edits take effect after the current day or longer period ends; further edits replace the pending change. A changed rhythm starts a new current streak while retaining earlier completions, best streaks, XP and rewards. Timezone changes also take effect after the current period, preserving its anchor and streak. Schedule history retains earlier rhythms and timezones. Legacy weekday history keeps its original streak behavior; new interval edits record an explicit reset marker. Dates use IANA timezones, not the server's local clock.
- Goal steps may be undated or have a date. Today shows due and overdue steps, plus a “Whenever you have time” section suggesting the first unfinished undated step from each active goal in its existing order. Expand it to show all available undated steps and check them off directly. Optional steps earn XP without increasing the daily progress total; completed steps stay visible on the day they were finished, including in daily history. Past days show completed optional steps only. An empty goal does not complete.
- Undo recalculates XP, levels, streaks, badges, and unclaimed gifts. Claimed gifts remain in history. Archiving retains completion records and earned XP.
- After the first connected visit, install the app through your browser. On iOS use **Share → Add to Home Screen**.
- Individual goal steps can be deleted after confirmation. Deletion removes the step and its completion progress, including its XP, and survives synchronization with other devices. Goals themselves can still be archived with their history preserved.
- After the first connected profile visit, every feature except switching profiles and notification setup/delivery works offline: create/edit/archive habits, goals and gifts, create/edit/delete steps, reorder steps, check off or undo tasks, claim gifts, and save settings or avatars. Changes are committed to IndexedDB before the UI confirms success and survive reloads. Onboarding can finish offline once the initial profile has loaded. A new profile cannot initialize without that first connection.
- Local changes, reconnection, foreground focus, app launch, and manual retry trigger background synchronization. While the page is visible, idle sync checks every 5 seconds bring in changes from other devices without a refresh; hidden pages check every 60 seconds and sync immediately when brought forward. Cached startup and local saves never wait for API availability. The sync notice appears only after an operation has been running for 2.5 seconds. Requests time out after 10 seconds; failures retry with backoff and do not interrupt edits with network error dialogs. Background Sync support is not required. Retries are idempotent, and duplicate wins earn XP once.
- **Settings → View sync log** shows the last 50 sync operations for the current profile on this device, including timestamps, durations, pending change counts, retries, and outcomes. The log persists in IndexedDB and can be viewed offline.
- Browser-ID switches keep local documents, sync baselines, pending changes, and sync logs scoped to their original ID. Pending changes are never replayed into another account. IndexedDB transactions coordinate local writes across tabs; server revision checks coordinate concurrent uploads without holding browser locks during network requests.
- Sync performs a three-way merge against the last synchronized document. Independent additions and edits to different fields combine; the server value wins when both devices edit the same field differently. Completed wins conflicting completion changes, including an undo versus a remote undo/recompletion. Ordinary undo still works when the server completion has not changed since the baseline. Archives and gift claims survive conflicts. Schedule entries merge by effective date, with the server winning ties; timezone conflicts keep the server calendar schedules together. Step ordering preserves additions, using server ordering when both sides reorder. Original completion dates and timezones are retained.
- Existing browser caches upgrade without clearing profiles or pending checkoffs. Unreplayable legacy operations remain saved for recovery; **Use server progress** explicitly discards pending local changes and reloads saved data.
- Updates are prompted and cannot be activated while changes are pending. Reduced-motion preferences disable decorative motion and celebrations.

Browser storage is a local cache, not a backup. Unsynced changes depend on that browser's IndexedDB storage remaining available.

## API contract

All `/api/*` routes require the profile's UUID access key in `X-Machbar-User`. Missing credentials return 401; malformed UUIDs return 400. IDs in a URL or request body do not authenticate a request. Reads and writes are scoped to the header identity. The backend manages profile identity, validates synchronized documents, and persists them atomically; task rules and all derived progress run in the client.

| Route                  | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `GET /api/bootstrap`   | Stored user document and daily-history configuration         |
| `POST /api/local-user` | Load an existing profile; `{ userId }` must match the header |
| `PUT /api/sync`        | Save a complete merged `UserDocument`                        |
| `GET /health`          | Process health                                               |

Notification routes also require the identity header and same-origin writes:

| Route                                    | Purpose                                                   |
| ---------------------------------------- | --------------------------------------------------------- |
| `GET /api/notifications/config`          | `{ available, publicKey }`; never exposes the private key |
| `PUT /api/notifications/subscription`    | Register `{ subscription }`; returns `{ bindingId }`      |
| `DELETE /api/notifications/subscription` | Remove this profile’s `{ bindingId }` idempotently        |
| `POST /api/notifications/test`           | Send a test to this profile’s `{ bindingId }`             |

Bootstrap, profile switching, and sync return `{ document, dailyHistoryDays }`. The client calculates today, XP, levels, streaks, achievements, goal progress, gift availability, and plant growth.

To switch profiles, send the **target** profile's ID in both `X-Machbar-User` and `{ userId }`. Mismatches return `ACCOUNT_CHANGED` without loading or modifying either profile. Possession of a profile's UUID grants access to that profile; keep IDs and QR codes private and use HTTPS for public deployments.

Every `/api/*` request, including failed requests and unknown API paths, counts toward rate limits before identity checks and JSON parsing. Defaults per **60-second fixed window** are **300 requests per IP**, **120 per user ID** (across devices), and **20 per IP without a valid user ID**. Missing and malformed IDs share the anonymous allowance. The IP limit also applies to valid IDs, so rotating IDs cannot bypass it. Exceeded limits return 429 with `{ "code": "RATE_LIMITED" }` and a `Retry-After` header in seconds; `/health` and static assets remain available.

Configure `RATE_LIMIT_WINDOW_SECONDS` (1–86400), `RATE_LIMIT_MAX_PER_IP`, `RATE_LIMIT_MAX_PER_USER`, and `RATE_LIMIT_MAX_ANONYMOUS` through `.env` or the server environment, then restart the server or recreate the Compose container. Request limits must be positive integers. Counters live in memory, reset on restart or window expiry, and track at most 10,000 keys; new keys are denied until expiry if that capacity is reached. Run one application instance. IP limits use the connection address and ignore forwarding headers. Behind a reverse proxy, clients share the proxy's IP allowance; size that allowance for your deployment and enforce individual client IP limits at the proxy.

Sync sends `If-Match: <server revision>`, `X-Machbar-User: <userId>`, a same-origin `Origin`, and the complete document as JSON. Its `userId` and `revision` must match the identity header and expected revision. The server saves only if its current revision matches, then increments the revision. On `DOCUMENT_CONFLICT`, the client fetches the latest document, merges again, and retries. Failed or interrupted requests leave local pending changes intact. An acknowledgment clears only the captured batch; changes made during a request remain pending and are rebased onto the saved document. Sync accepts documents up to 8 MiB.

The stored document remains schema version 1. It includes task IDs, schedule history, archive/claim timestamps, completion records and operation receipts. Existing completion identities remain habit/date or goal-step ID. Period habits use habit/period-start identities and optional `periodStart` metadata while retaining the actual completion date and timezone; progress is derived from completed records, so retries do not award duplicate XP.

Errors return `{ "code": "STABLE_ERROR_CODE" }`. Common codes include `VALIDATION_ERROR`/`INVALID_IDENTITY` (400), `INVALID_IDENTITY` for missing credentials (401), `ORIGIN_REJECTED` (403), `NOT_FOUND`/`USER_NOT_FOUND` (404), `DOCUMENT_CONFLICT`/`ACCOUNT_CHANGED` (409), `REVISION_REQUIRED` (428), `RATE_LIMITED` (429), and `DATA_CORRUPT` (500). UI messages are translated.

Deploy the client and API together. For the interval update, close all open Machbar tabs/windows and reopen the app so the updated client activates before using new schedules. Existing documents, browser caches and pending daily checkoffs remain compatible; no data reset is needed. The old feature-specific mutation endpoints have been removed. When upgrading from the completion-only client, close all open Machbar tabs/windows and reopen the app so its waiting service worker can activate and migrate the local cache, including unsynced checkoffs. Browser data must remain intact during the upgrade.

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
pnpm exec playwright install chromium webkit
pnpm test:e2e
pnpm test:docker
docker compose config --quiet
docker compose up -d --build
curl http://localhost:3000/health
```

Browser tests exercise the production build on an isolated temporary data directory at port 3100. They cover desktop/mobile layouts, accessibility, all offline feature mutations, offline reload and synchronization, automatic conflicts, API outages, interrupted requests, cache upgrades, multiple tabs, and account switching. The `iphone` project uses WebKit with iPhone 17 Pro Max emulation to check mobile form sizing and menu navigation. An existing Chromium executable can be selected through `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Production does not contain the test reset or seed routes.

Docker tests build an isolated image and verify permission repair with existing root-owned profiles, a real API sync, the application's UID/GID and lack of effective capabilities, direct non-root startup, custom data directories, symlink preservation, and unwritable-mount errors. They require a local Linux Docker daemon without user namespace remapping and do not publish ports or use your application data.

## Challenge icons

Choose an icon when creating or editing a habit, goal, or step. Icons appear on the Today page and in their lists, keep the selected color (steps use their goal’s color), and sync across devices. Existing items keep their leaf or target icon until you select another.

## Plant growth

The Today plant grows into a rounded bush in 24-level branches: six levels add one leaf each, then the next eighteen add one blossom petal each, completing three six-petal blossoms. Petal levels do not add normal leaves. Once a branch is full, the next level begins a new branch spreading outward and upward through the crown. Blossoms sit over the foliage, and the whole plant zooms out uniformly as the bush fills out. Growth respects the device's reduced-motion setting.

## Credits

Choose **Edit avatar** in Settings to customize skin tone, hair, facial features, clothing, accessories, and background in a live preview. Randomize a look or reset your changes, then save the avatar. During onboarding, the avatar is saved when you finish your profile. Existing robot avatars remain until you save a custom portrait.

Icons: [Lucide](https://lucide.dev/license). Avatars: [DiceBear](https://www.dicebear.com/) with Pablo Stanley's [Bottts](https://bottts.com/) and [Avataaars](https://avataaars.com/) artwork, generated locally without a hosted avatar API. See `apps/web/public/credits.txt` and the Settings page for license notices.
