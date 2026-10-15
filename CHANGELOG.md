# Changelog

Changes to Machbar, listed per version from the root [`package.json`](package.json). Pushing a tag with that version publishes a release; its section below becomes the release notes.

## 1.0.0 - 2026-10-16

First release.

### Added

- Installable, offline-capable PWA to track daily habits, goals with steps, and the wins that come from them, in English and German.
- Habits with flexible schedules and recurring intervals, with streaks per habit.
- Goals that can be completed on their own or through steps, with optional step suggestions.
- Today page with the day's challenges, completed goals, achievements and gifts reached on the selected day, and inline buttons to create a habit or goal when none are active.
- Plant that grows with your level, XP and levels, and a confetti and "Level up!" celebration when you reach a new level (only the badge with reduced motion).
- Achievements with the date each one was reached.
- Gifts you promise yourself for a habit or goal milestone, with editing, icons, descriptions and an archive. Gifts whose habit or goal was archived are marked as stuck and can be moved to a new milestone, marked as received or deleted.
- Customizable avatars and challenge icons.
- Profiles synced across devices with an offline queue, a sync log, and profile switching by ID or QR code.
- Push notifications for habit, goal and step reminders, and an evening check-in reminder (default 20:00 in the profile timezone) when habits are still open and nothing was checked off.
- One-time hints to install the PWA and enable notifications.
- Build information in the app and an in-app update button.
- Admin page at `/admin` behind a password, in English and German, sharing theme, language and timezone with the app. It lists profiles with avatar, level, stats, creation time, last sync, latest check-in, last app version, full ID and QR code, deletes profiles, and shows rate limits and active bans. Deleted profile IDs cannot be uploaded again; the app then offers to start a new profile or switch to another one. Opens inside the installed PWA.
- Self-hosting with Docker and Docker Compose: profiles are stored in SQLite (older JSON data is migrated and archived), and the container repairs data permissions and then runs unprivileged.
- Server safeguards: rate limits per IP, profile and anonymous request with explicit trusted proxies, limits on profiles, document size and storage with a disk reserve, connection and request limits with timeouts, and an option to turn off profile creation.

### Fixed

- Profile identity is kept when the PWA is installed on iOS.
- The PWA update button reloads into the new version.
