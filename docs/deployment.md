# Deployment reference

[← README](../README.md)

For installation steps and environment-variable defaults, see the [README](../README.md#installation). This reference covers storage, access, reminders, and maintenance in more detail.

## Container startup and storage

Open **http://localhost:3000**, create a profile, then configure your name, language, timezone, and avatar and add your first habit or goal. Public profile creation is enabled by default; set `DISABLE_USER_CREATION=true` to require locally provisioned profiles. Data lives in the persistent `machbar_data` volume. The entrypoint starts as root to prepare the data directory and existing SQLite files and legacy JSON snapshots, then replaces itself with the app running as the unprivileged `node` user (UID/GID **1000:1000**). Compose keeps the application filesystem read-only and exposes `/health` for health checks.

To store data in a host directory, replace the volume mapping with a bind mount, for example `/srv/data/machbar:/app/data`. On startup the image automatically repairs ownership and enforces owner-only permissions: **0700** on the mounted directory and its `migration-backup` folder, and **0600** on archived JSON files and its regular `data.db`, `data.db-*`, and `*.json` files. This removes existing group/world access and also fixes `EACCES: permission denied` errors during sync when Docker created the host directory as root. Repairs preserve existing JSON contents and skip symlinked profile files. Direct non-root startup enforces the same modes on already-owned data. Absolute `DATA_DIR` overrides are supported. A failed repair or an unwritable data directory stops startup with an explanatory error.

The Compose capabilities `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETUID`, and `SETGID` allow the startup repair and user switch; the app runs without effective capabilities after the switch. If you require a non-root container from its first instruction, pre-create the data directory with ownership **1000:1000**, give its owner directory read/write/search access and existing SQLite and JSON files read/write access, set `user: '1000:1000'`, and remove `cap_add` while keeping `cap_drop: [ALL]`. This skips automatic ownership repair and still checks that the directory is writable. Non-root process execution is separate from [Docker's rootless daemon mode](https://docs.docker.com/engine/security/rootless/): with a rootless daemon or user namespaces, bind-mount ownership must use the daemon's mapped IDs.

By default the port binds to all network interfaces. Other devices can open `http://<server-ip>:3000`; the app accepts same-origin writes through that address. Set `BIND_ADDRESS=127.0.0.1` to limit access to the host. For a public deployment, place an HTTPS reverse proxy in front of the app and set `APP_URL=https://machbar.example.com`. Service workers require HTTPS, except on localhost.

Run **one application instance** against the data volume. Profile writes are serialized per user and committed in SQLite transactions with revision checks and durable rollback journals; this is not a shared-filesystem cluster or a horizontally scalable service.

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

Subscriptions and dispatch records are saved in `DATA_DIR/data.db` alongside profiles, with owner-only permissions. Include the entire data directory in stopped-server backups and preserve the VAPID configuration. Successful dispatches and ambiguous delivery attempts are not replayed after restart; DNS/connection failures before delivery and explicit 429/5xx push-service failures retry with backoff until expiry, and 404/410 removes expired subscriptions. A crash between claiming a dispatch and sending it can miss that reminder. The Settings test button verifies the delivery path and allows one test per minute per device.

Disabling notifications immediately clears this device’s local opt-in, unsubscribes from browser push, and closes displayed reminders. If server cleanup is offline, it retries after reconnection. Switching profiles removes the old device binding; the new profile requires explicit opt-in. Browser permission itself remains under browser/device settings. After upgrading Machbar, install the offered update and reopen old tabs before enabling or editing reminders; no profile reset is required.

## Browser profiles

There is no login. Browsers can create profiles using locally generated UUIDs by default. When `DISABLE_USER_CREATION=true`, administrators provision profiles locally and give each user their private UUID to enter on the profile selection screen. The UUID is stored in local storage (`machbar-user-id`), with the profile saved in the server’s `data.db` database. Open **Switch User** from the avatar menu to see and copy your ID or QR code. On another device, enter that existing ID, scan its QR code with the camera, or upload a QR image, then choose **Switch profile**. Camera scanning requires HTTPS or localhost; manual entry and QR image upload also work on LAN HTTP. Sync or discard pending changes before switching. Your previous profile stays saved.

Profile IDs stay in origin-scoped local storage; they are never backed up in cookies, which would expose the access key to other services sharing the hostname on different ports. When upgrading an older installation, an existing legacy cookie is restored only if local storage has no valid ID, then deleted. Existing local storage takes precedence. Sync pending changes and copy your ID before installing a Home Screen app. If the installed app has separate browser storage (including iOS), use **Switch User** inside the app to restore the ID shown in your browser.

Keep your ID or QR code somewhere safe: clearing browser storage loses the saved ID, so enter it again to restore access. Anyone who knows an ID can access and edit that profile. The ID is an access key, not a login.

The data directory is never exposed by the web server.

## Backup and restore

Stop the app before copying the entire data directory for a consistent backup. Use a fresh backup directory for each snapshot:

```bash
docker compose stop machbar
mkdir -p backups
docker compose cp machbar:/app/data ./backups/machbar-data
docker compose start machbar
```

Keep backups private: they contain profile and task history, including originals in `migration-backup`. Save deployment configuration separately. To restore, stop the app and restore the complete backup into an **empty data volume**, then preserve ownership for UID/GID **1000** and mode **0600**. Keep the old volume separately until you have verified the restore. The commands below refuse a nonempty destination; configure a fresh volume or bind mount first. A legacy JSON-only backup is migrated on its first startup. Mixing a JSON-only backup with an existing SQLite database will not restore the JSON data. One way to perform maintenance is a temporary Compose container:

```bash
docker compose run --rm --no-deps --user root --entrypoint sh \
  -v "$PWD/backups/machbar-data:/backup:ro" machbar \
  -c 'test -z "$(ls -A /app/data)" && cp -a /backup/. /app/data/ && chown 1000:1000 /app/data && chmod 700 /app/data && find /app/data -maxdepth 1 -type f \( -name "*.json" -o -name "data.db" -o -name "data.db-*" \) -exec chown 1000:1000 {} + -exec chmod 600 {} +'
docker compose start machbar
```

For standalone Docker, use `docker stop machbar`, `docker cp machbar:/app/data ./backups/machbar-data`, and `docker start machbar` for the backup. To restore into the named volume from the README's Docker example, keep the app stopped and run:

```bash
docker run --rm --user root --entrypoint sh \
  -v machbar_data:/app/data \
  -v "$PWD/backups/machbar-data:/backup:ro" machbar:local \
  -c 'test -z "$(ls -A /app/data)" && cp -a /backup/. /app/data/ && chown 1000:1000 /app/data && chmod 700 /app/data && find /app/data -maxdepth 1 -type f \( -name "*.json" -o -name "data.db" -o -name "data.db-*" \) -exec chown 1000:1000 {} + -exec chmod 600 {} +'
docker start machbar
```

SQLite uses rollback journals rather than WAL. After a clean shutdown, `data.db` contains all committed state; copying the complete stopped data directory also preserves any recovery journal after an interrupted shutdown. Do not copy only a live database file. Corrupt persisted profiles produce `DATA_CORRUPT` and corrupt push state produces `PUSH_DATA_CORRUPT` rather than being replaced with blank data.

## SQLite upgrades and rollback

The first server startup or local provisioning command automatically imports all recognized `<userId>.json` profiles and `push-state.json` in the existing `DATA_DIR`. No environment variables, volume paths, browser IDs, or API formats change. The migration validates profile identities and document schemas, preserves revisions and notification dispatch receipts, and imports even profiles that exceed current quotas or new-write limits. Temporary files and unrelated files are ignored. Recognized profiles and push state must be regular files; symlinks are rejected.

Make a stopped-server backup before upgrading. Migration requires disk space for SQLite in addition to the originals. All imported rows and SQLite schema version 2 commit together. An interrupted or failed transaction rolls back and can be retried on the next startup. If validation fails, startup names the problematic file and leaves every source file untouched; repair it and restart. SQLite integrity failures and newer unsupported database schemas stop startup rather than falling back to stale JSON.

Existing SQLite schema version 1 databases automatically migrate from JSON payloads in `records` into normalized tables during startup. Profiles, entity ordering, schedule history, revisions, optional fields, completion and operation receipts, push bindings, and dispatch receipts are preserved. Original payload byte charges are retained until the next write, so normalization does not reset quotas. The new tables, imported rows, removal of `records`, and version change commit in one transaction. Invalid data or broken entity references stop the upgrade with the record identity and leave the version 1 tables intact for repair and retry. Pending JSON archive moves also resume after the upgrade.

After a successful import, SQLite is authoritative. The server creates `DATA_DIR/migration-backup` when needed and moves the imported profile JSON files and `push-state.json` into it, preserving their contents. These recovery snapshots do not count toward the payload quota and are never reimported into that database. A durable archive queue resumes interrupted moves on startup. If a backup destination contains different data, startup stops without overwriting it or removing the original; resolve the conflict and restart to finish archiving. The SQLite import remains saved. New profiles and subsequent changes are written only to SQLite. Keep the originals private and remove the backup folder after verifying the upgrade if desired.

Schema version 1 releases cannot open a schema version 2 database. To roll back to the earlier SQLite release, stop the server and restore its pre-upgrade SQLite backup into a separate empty volume. This loses changes made after the backup; do not run either release against the other schema.

To roll back to a JSON-based release, stop the server and restore the **pre-upgrade JSON backup into a separate empty volume** before starting the old release. The JSON files in `migration-backup` represent the moment of migration; rolling back this way loses later SQLite changes. To preserve later changes, stay on the SQLite release and restore a stopped-server SQLite backup. Do not run old and new releases against the same data volume.

## Profile provisioning and storage quotas

To provision another profile, stop the server so only one process owns its data directory, run the local provisioning command, then restart it:

```bash
docker compose stop machbar
docker compose run --rm --no-deps machbar node api/dist/provision-user.js 'Alice'
docker compose up -d
```

For a local installation, stop the server and run `node apps/api/dist/provision-user.js 'Alice'` after building. The name is optional. Provisioning uses the configured data directory and persistent quotas, writes a private SQLite profile record, and prints its UUID; keep it private. There is no HTTP provisioning endpoint.

**Existing deployments:** explicit `.env` values continue to apply. To enable public registration, change `DISABLE_USER_CREATION=true` to `false` and restart or recreate the server. To close public registration, set `DISABLE_USER_CREATION=true`; existing profiles and saved IDs continue to work. Public registration permits anyone with network access to create profiles and consume the shared profile/storage quotas; rate limits only slow this down. Use public registration only on a trusted network or behind an access-controlled proxy.

Relative data/web paths resolve from the repository root so development and production share the same local data directory.

Storage is bounded by default: **100 saved profiles**, **256 MiB** of stored UTF-8 profile and push payloads in SQLite, and a **64 MiB** free-space reserve. Set `MAX_PROFILES`, `MAX_STORAGE_BYTES`, and `STORAGE_RESERVE_BYTES` to positive integers to adjust these limits. Quota usage and profile count are queried from SQLite inside the write transaction and survive restarts. SQLite pages, rollback journals, and retained legacy files do not count toward `MAX_STORAGE_BYTES`, but occupy real disk space. Writes also require the free-space reserve plus room for replacement payloads, journal entries, and pages. Existing profiles remain readable when a quota is lowered, and writes that reduce over-quota payload usage are allowed if the free-space reserve is satisfied. Limits never delete existing data. New profiles stop saving at the profile quota; existing profiles can still sync within the storage budget. For a closed deployment, keep `DISABLE_USER_CREATION=true` after provisioning your profiles.
