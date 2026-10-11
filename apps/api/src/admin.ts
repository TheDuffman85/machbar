import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { levelFor, localUserIdSchema, type AvatarOptions } from '@machbar/shared';
import { avatarImage } from '@machbar/shared/avatar-image';
import type { Config } from './config.js';
import type { SqliteDatabase } from './database.js';
import { avatarFields } from './database-schema.js';
import { removeUserBindings, type PushStore } from './notifications.js';
import type { SqliteStore } from './store.js';
import { verifyAdminPassword } from './hash-admin-password.js';
import type { UserCreation } from './user-creation.js';
import type { RateLimiter, RateLimitBlock, RateLimitStatus } from './rate-limit.js';

type ProfileRow = {
  userId: string;
  name: string;
  language: string;
  timezone: string;
  onboarded: boolean;
  revision: number;
  bytes: number;
  createdAt: string | null;
  updatedAt: string | null;
  clientVersion: string | null;
  avatar: string;
  habits: number;
  archivedHabits: number;
  goals: number;
  archivedGoals: number;
  steps: number;
  gifts: number;
  claimedGifts: number;
  completions: number;
  lastCompletion: string | null;
  devices: number;
  /** Inline SVG of the plain user ID, which the app's Switch User scanner reads. */
  qr: string;
};
type RateLimits = {
  api: RateLimitStatus;
  login: { resetAt: number; tracked: number; lockouts: Array<{ ip: string; count: number }> };
};

export const adminDeleteRoute = '/admin/profiles/:userId/delete';
// The only non-API POST routes; server.ts rejects every other non-GET request.
export const adminPostRoutes = new Set([
  '/admin/login',
  '/admin/logout',
  '/admin/theme',
  '/admin/user-creation',
  adminDeleteRoute,
]);
const sessionCookie = 'machbar_admin';
const themeCookie = 'machbar_admin_theme';
type Theme = 'light' | 'dark' | 'system';
// Durations offered for temporarily opening profile creation, in minutes.
const creationWindows = [15, 60, 24 * 60];
const sessionSeconds = 12 * 60 * 60;
const maxSessions = 100;
const maxLoginFailures = 10;
// Listed bans per kind; an attack can fill thousands of counters.
const maxListedBans = 50;
const digest = (value: string) => createHash('sha256').update(value).digest();
const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );
const cookieValue = (request: FastifyRequest, name: string) => {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
};

// Hidden operator page: no link from the app, disabled unless an admin
// password hash is configured. Same-origin checks for its POSTs come from identity.ts.
export function registerAdmin(
  app: FastifyInstance,
  config: Config,
  store: SqliteStore,
  database: SqliteDatabase,
  push: PushStore,
  userCreation: UserCreation,
  rateLimiter: RateLimiter,
) {
  const credentials = config.admin;
  if (!credentials) return;
  const secure = config.appUrl.startsWith('https:');
  // Sessions live in memory (SHA-256 of the token -> expiry), so a restart
  // signs the admin out. The oldest session is dropped when the table is full.
  const sessions = new Map<string, number>();
  const session = (request: FastifyRequest) => {
    const token = cookieValue(request, sessionCookie);
    if (!token) return undefined;
    const key = digest(token).toString('hex');
    const expires = sessions.get(key);
    if (expires === undefined) return undefined;
    if (expires > Date.now()) return key;
    sessions.delete(key);
    return undefined;
  };
  const setCookie = (reply: FastifyReply, token: string, maxAge: number) =>
    reply.header(
      'Set-Cookie',
      `${sessionCookie}=${token}; Path=/admin; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
    );
  // Failed logins per IP in a fixed window. Fail closed when the table is full.
  const failures = new Map<string, number>();
  let resetAt = 0;
  const resetFailures = () => {
    if (Date.now() >= resetAt) {
      failures.clear();
      resetAt = Date.now() + config.rateLimitWindowSeconds * 1000;
    }
  };
  const lockedFor = (ip: string) => {
    resetFailures();
    const failed = failures.get(ip) ?? 0;
    return failed >= maxLoginFailures || (failed === 0 && failures.size >= 10_000)
      ? Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
      : 0;
  };
  const rateLimits = (): RateLimits => {
    resetFailures();
    const lockouts = [...failures]
      .filter(([, count]) => count >= maxLoginFailures)
      .map(([ip, count]) => ({ ip, count }));
    return { api: rateLimiter.status(), login: { resetAt, tracked: failures.size, lockouts } };
  };
  // Only a display preference, so a plain cookie readable by any /admin request.
  const theme = (request: FastifyRequest): Theme => {
    const value = cookieValue(request, themeCookie);
    return value === 'light' || value === 'dark' ? value : 'system';
  };
  const loginPage = (request: FastifyRequest, reply: FastifyReply, code: number, error?: string) =>
    reply
      .code(code)
      .type('text/html; charset=utf-8')
      .send(renderLogin(theme(request), error));

  const profiles = async (): Promise<{ rows: Omit<ProfileRow, 'qr'>[]; deleted: number }> => {
    const db = await database.ready();
    db.exec('BEGIN');
    try {
      const avatars = new Map(
        db
          .prepare('SELECT * FROM profile_avatars')
          .all()
          .map((row) => [
            String(row.user_id),
            Object.fromEntries(
              avatarFields.filter((field) => row[field] !== null).map((f) => [f, row[f]]),
            ) as AvatarOptions,
          ]),
      );
      const count = (table: string, where = '') =>
        `(SELECT COUNT(*) FROM ${table} t WHERE t.user_id = p.user_id ${where})`;
      const rows = db
        .prepare(
          `SELECT p.*,
            ${count('habits', 'AND t.archived_at IS NULL')} AS habits,
            ${count('habits', 'AND t.archived_at IS NOT NULL')} AS archived_habits,
            ${count('goals', 'AND t.archived_at IS NULL')} AS goals,
            ${count('goals', 'AND t.archived_at IS NOT NULL')} AS archived_goals,
            ${count('steps', 'AND t.archived_at IS NULL')} AS steps,
            ${count('gifts', 'AND t.archived_at IS NULL')} AS gifts,
            ${count('gifts', 'AND t.claimed_at IS NOT NULL')} AS claimed_gifts,
            ${count('completions', 'AND t.completed = 1')} AS completions,
            (SELECT MAX(t.updated_at) FROM completions t WHERE t.user_id = p.user_id)
              AS last_completion,
            ${count('push_bindings')} AS devices
          FROM profiles p
          ORDER BY p.updated_at IS NULL, p.updated_at DESC, p.name`,
        )
        .all();
      const deleted = Number(
        db.prepare('SELECT COUNT(*) AS count FROM deleted_profiles').get()!.count,
      );
      db.exec('COMMIT');
      const result = rows.map((row) => {
        const userId = String(row.user_id);
        return {
          userId,
          name: String(row.name),
          language: String(row.language),
          timezone: String(row.timezone),
          onboarded: Boolean(row.onboarded),
          revision: Number(row.revision),
          bytes: Number(row.logical_bytes),
          createdAt: row.created_at === null ? null : String(row.created_at),
          updatedAt: row.updated_at === null ? null : String(row.updated_at),
          clientVersion: row.client_version === null ? null : String(row.client_version),
          avatar: avatarImage(
            String(row.avatar_seed),
            row.avatar_mode === 2 ? avatars.get(userId) : null,
          ),
          habits: Number(row.habits),
          archivedHabits: Number(row.archived_habits),
          goals: Number(row.goals),
          archivedGoals: Number(row.archived_goals),
          steps: Number(row.steps),
          gifts: Number(row.gifts),
          claimedGifts: Number(row.claimed_gifts),
          completions: Number(row.completions),
          lastCompletion: row.last_completion === null ? null : String(row.last_completion),
          devices: Number(row.devices),
        };
      });
      return { rows: result, deleted };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const qr = (userId: string) =>
    QRCode.toString(userId, { type: 'svg', margin: 4 }).then((svg) =>
      svg.replace('<svg ', '<svg role="img" aria-label="QR code of the user ID" '),
    );

  void app.register(async (admin) => {
    admin.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_request, body, done) => done(null, new URLSearchParams(body as string)),
    );
    admin.addHook('onSend', async (_request, reply, payload) => {
      reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow');
      return payload;
    });
    const page = async (request: FastifyRequest, reply: FastifyReply) => {
      if (!session(request)) return loginPage(request, reply, 200);
      const { rows, deleted } = await profiles();
      const withQr = await Promise.all(
        rows.map(async (row) => ({ ...row, qr: await qr(row.userId) })),
      );
      const notice = (request.query as Record<string, unknown>).deleted;
      const message = notice === '1' ? 'deleted' : notice === '0' ? 'missing' : undefined;
      return reply
        .type('text/html; charset=utf-8')
        .send(
          renderPage(
            { rows: withQr, deleted },
            rateLimits(),
            config,
            userCreation,
            theme(request),
            message,
          ),
        );
    };
    admin.get('/admin', page);
    admin.get('/admin/', page);
    admin.get('/admin/admin.js', async (request, reply) => {
      if (!session(request)) return reply.code(401).send({ code: 'UNAUTHORIZED' });
      return reply.type('text/javascript; charset=utf-8').send(script);
    });
    admin.post('/admin/login', async (request, reply) => {
      const retryAfter = lockedFor(request.ip);
      if (retryAfter)
        return loginPage(
          request,
          reply.header('Retry-After', String(retryAfter)),
          429,
          'Too many failed attempts. Try again later.',
        );
      const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
      // Count the attempt before the slow hash so parallel guesses cannot pass the limit.
      failures.set(request.ip, (failures.get(request.ip) ?? 0) + 1);
      if (!(await verifyAdminPassword(form.get('password') ?? '', credentials.passwordHash)))
        return loginPage(request, reply, 401, 'Wrong password.');
      failures.set(request.ip, Math.max(0, (failures.get(request.ip) ?? 1) - 1));
      const token = randomBytes(32).toString('base64url');
      for (const [key, expires] of sessions) if (expires <= Date.now()) sessions.delete(key);
      if (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value!);
      sessions.set(digest(token).toString('hex'), Date.now() + sessionSeconds * 1000);
      request.log.info('Admin signed in');
      return setCookie(reply, token, sessionSeconds).redirect('/admin', 303);
    });
    admin.post('/admin/logout', async (request, reply) => {
      const key = session(request);
      if (key) sessions.delete(key);
      return setCookie(reply, '', 0).redirect('/admin', 303);
    });
    admin.post('/admin/theme', async (request, reply) => {
      const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
      const value = form.get('theme');
      const cookie = `${themeCookie}=${value}; Path=/admin; SameSite=Strict${secure ? '; Secure' : ''}`;
      reply.header(
        'Set-Cookie',
        value === 'light' || value === 'dark'
          ? `${cookie}; Max-Age=${365 * 24 * 60 * 60}`
          : `${themeCookie}=; Path=/admin; Max-Age=0`,
      );
      return reply.redirect('/admin', 303);
    });
    admin.post('/admin/user-creation', async (request, reply) => {
      if (!session(request)) return reply.redirect('/admin', 303);
      const form = request.body instanceof URLSearchParams ? request.body : new URLSearchParams();
      const minutes = Number(form.get('minutes'));
      if (minutes === 0) {
        userCreation.close();
        request.log.info('Admin closed user creation');
      } else if (creationWindows.includes(minutes)) {
        userCreation.open(minutes * 60 * 1000);
        request.log.info({ minutes }, 'Admin opened user creation');
      } else return reply.code(400).send({ code: 'VALIDATION_ERROR' });
      return reply.redirect('/admin', 303);
    });
    admin.post(adminDeleteRoute, async (request, reply) => {
      // An expired session lands on the login form instead of an error body.
      if (!session(request)) return reply.redirect('/admin', 303);
      const parsed = localUserIdSchema.safeParse((request.params as { userId: string }).userId);
      if (!parsed.success) return reply.code(404).send({ code: 'NOT_FOUND' });
      const removed = await store.remove(parsed.data);
      // Subscriptions are not tied to the profile row; remove them so the
      // scheduler stops looking up a profile that no longer exists.
      await removeUserBindings(push, parsed.data);
      if (removed) request.log.info({ userId: parsed.data.slice(0, 8) }, 'Admin deleted profile');
      return reply.redirect(`/admin?deleted=${removed ? 1 : 0}`, 303);
    });
  });
}

const script = `const dialog = document.getElementById('confirm-delete');
const form = dialog.querySelector('form');
for (const button of document.querySelectorAll('[data-delete]'))
  button.addEventListener('click', () => {
    form.action = button.dataset.delete;
    dialog.querySelector('[data-name]').textContent = button.dataset.name;
    dialog.showModal();
  });
// Without the Clipboard API (plain HTTP on a LAN) the ID is selected for a manual copy.
for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  let reset;
  button.addEventListener('click', async () => {
    const id = button.parentElement.querySelector('code');
    try {
      await navigator.clipboard.writeText(id.textContent);
      button.textContent = 'Copied';
    } catch {
      getSelection().selectAllChildren(id);
      button.textContent = 'Selected, press Ctrl+C';
    }
    clearTimeout(reset);
    reset = setTimeout(() => (button.textContent = 'Copy ID'), 2500);
  });
}
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
for (const time of document.querySelectorAll('time[datetime]')) {
  const date = new Date(time.dateTime);
  time.title = date.toLocaleString();
  const seconds = (date.getTime() - Date.now()) / 1000;
  if (!time.hasAttribute('data-relative')) time.textContent = date.toLocaleString();
  else if (seconds > 0 && seconds < 60) time.textContent = relative.format(Math.ceil(seconds), 'second');
  else if (Math.abs(seconds) < 60) time.textContent = 'just now';
  else {
    const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size);
    time.textContent = relative.format(Math.round(seconds / size), unit);
  }
}
`;

const bytes = (value: number) =>
  value < 1024
    ? `${value} B`
    : value < 1024 ** 2
      ? `${(value / 1024).toFixed(1)} KiB`
      : `${(value / 1024 ** 2).toFixed(1)} MiB`;
// Times marked relative are shown as "3 hours ago" by admin.js; the UTC text is the no-JS fallback.
const time = (value: string | null, missing = 'unknown', relative = false) => {
  if (value === null) return `<span class="muted">${missing}</span>`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return escape(value);
  const utc = `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `<time datetime="${escape(date.toISOString())}"${relative ? ' data-relative' : ''}>${utc}</time>`;
};
const stat = (label: string, value: string | number, detail = '') =>
  `<div><dt>${label}</dt><dd>${value}${detail ? ` <small>${detail}</small>` : ''}</dd></div>`;
const usage = (label: string, used: string, limit: string, ratio: number) => {
  const percent = Math.min(100, ratio * 100);
  return `<div class="tile">
    <dt>${label}</dt>
    <dd>${used} / ${limit} <small>${percent < 1 && percent > 0 ? '<1' : Math.round(percent)}% used</small></dd>
    <div class="meter${percent >= 90 ? ' full' : ''}" aria-hidden="true">${percent > 0 ? `<span style="width: ${percent.toFixed(2)}%"></span>` : ''}</div>
  </div>`;
};
const duration = (minutes: number) =>
  minutes % 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
const icons: Record<Theme, string> = {
  light:
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2m-7.07-17.07 1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  dark: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  system: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8m-4-4v4"/>',
};
// Works without JavaScript: each button posts the choice and the page reloads.
const themeSwitch = (current: Theme) => `<form class="theme" method="post" action="/admin/theme">
  <fieldset>
    <legend>Appearance</legend>
    ${(['light', 'dark', 'system'] as const)
      .map(
        (value) =>
          `<button type="submit" name="theme" value="${value}" aria-pressed="${value === current}"><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${icons[value]}</svg><span>${value[0]!.toUpperCase()}${value.slice(1)}</span></button>`,
      )
      .join('')}
  </fieldset>
</form>`;
function creationPanel(config: Config, userCreation: UserCreation) {
  if (!config.disableUserCreation)
    return `<section class="panel creation" aria-labelledby="creation-title">
  <div>
    <h2 id="creation-title" class="open">User creation enabled</h2>
    <p class="muted">Open to everyone, because <code>DISABLE_USER_CREATION</code> is <code>false</code>.</p>
  </div>
</section>`;
  const until = userCreation.openUntil();
  return `<section class="panel creation" aria-labelledby="creation-title">
  <div>
    ${
      until === null
        ? '<h2 id="creation-title">User creation disabled</h2>\n    <p class="muted">Open it temporarily so new visitors can create profiles.</p>'
        : `<h2 id="creation-title" class="open">User creation temporarily open</h2>\n    <p class="muted">Until ${time(new Date(until).toISOString())}. It closes again at that time or when the server restarts.</p>`
    }
  </div>
  <form method="post" action="/admin/user-creation" class="windows">
    ${creationWindows
      .map(
        (minutes) =>
          `<button type="submit" name="minutes" value="${minutes}">${until === null ? 'Open' : 'Extend'} for ${duration(minutes)}</button>`,
      )
      .join('\n    ')}
    ${until === null ? '' : '<button type="submit" name="minutes" value="0" class="danger">Close now</button>'}
  </form>
</section>`;
}

const banLabels: Record<RateLimitBlock['scope'], string> = {
  ip: 'API requests per IP',
  user: 'API requests per profile',
  anonymous: 'Requests without a valid ID',
  creation: 'New profiles',
};
const banOrder = Object.keys(banLabels);
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
// Configured limits and the counters that currently answer 429. Counters live in
// memory per fixed window, so a ban always ends when its window resets.
function rateLimitPanel({ api, login }: RateLimits, config: Config, rows: ProfileRow[]) {
  const names = new Map(rows.map((row) => [row.userId, row.name]));
  const until = (resetAt: number) => time(new Date(resetAt).toISOString(), '', true);
  const who = ({ scope, key }: RateLimitBlock) => {
    if (scope === 'creation' && key === 'global') return 'all addresses';
    if (scope !== 'user') return `<code>${escape(key)}</code>`;
    const name = names.get(key);
    return name === undefined
      ? `<code>${escape(key.slice(0, 8))}</code> <span class="muted">no saved profile</span>`
      : `${escape(name)} <code>${escape(key.slice(0, 8))}</code>`;
  };
  const blocked = [...api.blocked].sort(
    (a, b) => banOrder.indexOf(a.scope) - banOrder.indexOf(b.scope) || b.count - a.count,
  );
  const bans = [
    ...(api.tracked >= api.capacity
      ? [
          `<li class="alert"><span>Counter table full</span> <span class="muted">Requests from new IPs and IDs are rejected · resets ${until(api.resetAt)}</span></li>`,
        ]
      : []),
    ...(login.tracked >= 10_000
      ? [
          `<li class="alert"><span>Admin sign-in table full</span> <span class="muted">Sign-ins from new IPs are rejected · resets ${until(login.resetAt)}</span></li>`,
        ]
      : []),
    ...blocked
      .slice(0, maxListedBans)
      .map(
        (ban) =>
          `<li><span>${banLabels[ban.scope]}</span> ${who(ban)} <span class="muted">${ban.count} / ${ban.limit} · lifted ${until(api.resetAt)}</span></li>`,
      ),
    ...login.lockouts
      .slice(0, maxListedBans)
      .map(
        ({ ip, count }) =>
          `<li><span>Admin sign-in</span> <code>${escape(ip)}</code> <span class="muted">${plural(count, 'failed attempt')} · lifted ${until(login.resetAt)}</span></li>`,
      ),
  ];
  const hidden =
    Math.max(0, blocked.length - maxListedBans) +
    Math.max(0, login.lockouts.length - maxListedBans);
  const active = api.blocked.length + login.lockouts.length;
  const full = api.tracked >= api.capacity || login.tracked >= 10_000;
  return `<section class="panel limits" aria-labelledby="limits-title">
  <div class="limits-head">
    <div>
      <h2 id="limits-title">Rate limits</h2>
      <p class="muted">Counted in fixed windows of ${plural(config.rateLimitWindowSeconds, 'second')}; the current one resets ${until(api.resetAt)}. Counters are kept in memory and cleared on restart.</p>
    </div>
    <span class="badge${active || full ? ' alert' : ''}">${active ? plural(active, 'active ban') : full ? 'Counters full' : 'No active bans'}</span>
  </div>
  <dl class="stats">
    ${stat('Per IP', config.rateLimitMaxPerIp, 'API requests')}
    ${stat('Per profile', config.rateLimitMaxPerUser, 'across devices')}
    ${stat('Without ID', config.rateLimitMaxAnonymous, 'per IP')}
    ${stat('New profiles', config.rateLimitMaxNewUsers, 'per IP and in total')}
    ${stat('Admin sign-in', maxLoginFailures, 'failures per IP')}
    ${stat('Counters', `${api.tracked.toLocaleString('en')} / ${api.capacity.toLocaleString('en')}`, 'tracked this window')}
  </dl>
  <h3>Currently blocked</h3>
  ${
    bans.length
      ? `<ul class="bans">\n    ${bans.join('\n    ')}${hidden ? `\n    <li class="muted">and ${hidden} more</li>` : ''}\n  </ul>`
      : '<p class="muted">Nobody is blocked right now.</p>'
  }
</section>`;
}

function renderPage(
  { rows, deleted }: { rows: ProfileRow[]; deleted: number },
  limits: RateLimits,
  config: Config,
  userCreation: UserCreation,
  theme: Theme,
  notice?: 'deleted' | 'missing',
) {
  const used = rows.reduce((sum, row) => sum + row.bytes, 0);
  const cards = rows
    .map((row) => ({ ...row, ...levelFor(row.completions) }))
    .map(
      (row) => `<li class="card">
  <header>
    <img src="${row.avatar}" alt="" width="48" height="48">
    <div class="who">
      <h3>${escape(row.name)}</h3>
      <p class="muted"><code>${row.userId.slice(0, 8)}</code> · ${escape(row.language)} · ${escape(row.timezone)}${row.onboarded ? '' : ' · <span class="badge">not onboarded</span>'}</p>
    </div>
    <button type="button" class="delete" data-delete="/admin/profiles/${row.userId}/delete" data-name="${escape(row.name)}">Delete</button>
  </header>
  <dl class="stats">
    ${stat('Level', row.level, `${row.levelXp} / 100 XP`)}
    ${stat('Habits', row.habits, row.archivedHabits ? `+${row.archivedHabits} archived` : '')}
    ${stat('Goals', row.goals, row.archivedGoals ? `+${row.archivedGoals} archived` : '')}
    ${stat('Steps', row.steps)}
    ${stat('Gifts', row.gifts, row.claimedGifts ? `${row.claimedGifts} claimed` : '')}
    ${stat('Check-ins', row.completions)}
  </dl>
  <dl class="meta">
    ${stat('Last check-in', time(row.lastCompletion, 'never', true))}
    ${stat('Last sync', time(row.updatedAt, 'unknown', true))}
    ${stat('Created', time(row.createdAt, 'unknown', true))}
    ${stat('App version', row.clientVersion === null ? '<span class="muted">unknown</span>' : `<code>${escape(row.clientVersion)}</code>`)}
    ${stat('Push devices', row.devices)}
    ${stat('Revision', row.revision)}
    ${stat('Stored', bytes(row.bytes))}
  </dl>
  <details class="identity">
    <summary>User ID and QR code</summary>
    <div>
      ${row.qr}
      <div class="id">
        <code>${row.userId}</code>
        <button type="button" data-copy hidden>Copy ID</button>
        <p class="muted">Enter this ID or scan the code under <strong>Switch User</strong> in the app to open the profile on another device.</p>
      </div>
    </div>
  </details>
</li>`,
    )
    .join('\n');
  return layout(
    'Machbar admin',
    theme,
    `<main>
<div class="top">
  <h1><img src="/favicon.svg" alt="" width="28" height="28">Machbar admin</h1>
  <div class="tools">
    ${themeSwitch(theme)}
    <form method="post" action="/admin/logout"><button type="submit">Sign out</button></form>
  </div>
</div>
${notice === 'deleted' ? '<p class="notice" role="status">Profile deleted.</p>' : ''}
${notice === 'missing' ? '<p class="notice" role="status">That profile no longer exists.</p>' : ''}
<dl class="overview">
  ${usage('Profiles', String(rows.length), String(config.maxProfiles), rows.length / config.maxProfiles)}
  ${usage('Profile storage', bytes(used), bytes(config.maxStorageBytes), used / config.maxStorageBytes)}
  <div class="tile">
    <dt>Blocked IDs</dt>
    <dd>${deleted} <small>deleted ${deleted === 1 ? 'ID' : 'IDs'} blocked</small></dd>
  </div>
</dl>
${creationPanel(config, userCreation)}
${rateLimitPanel(limits, config, rows)}
<h2 class="section">Profiles</h2>
${rows.length ? `<ul>\n${cards}\n</ul>` : '<p class="empty muted">No saved profiles yet.</p>'}
</main>
<dialog id="confirm-delete" aria-labelledby="confirm-title">
  <form method="post">
    <h2 id="confirm-title">Delete profile?</h2>
    <p><strong data-name></strong> and all of its habits, goals, gifts, check-ins and push subscriptions will be permanently deleted. Its ID is blocked, so devices that still have the profile cannot upload it again. This cannot be undone.</p>
    <div class="actions">
      <button type="submit" formmethod="dialog" autofocus>Cancel</button>
      <button type="submit" class="danger">Delete profile</button>
    </div>
  </form>
</dialog>
<script src="/admin/admin.js"></script>
`,
  );
}

// No theme switch here; it follows the system or the choice made after signing in.
function renderLogin(theme: Theme, error?: string) {
  return layout(
    'Machbar admin sign-in',
    theme,
    `<main>
<form class="login" method="post" action="/admin/login">
  <h1>Machbar admin</h1>
  ${error ? `<p class="error" role="alert">${escape(error)}</p>` : ''}
  <label>Password <input name="password" type="password" autocomplete="current-password" required autofocus></label>
  <button type="submit" class="primary">Sign in</button>
</form>
</main>
`,
  );
}

function layout(title: string, theme: Theme, body: string) {
  return `<!doctype html>
<html lang="en"${theme === 'system' ? '' : ` data-theme="${theme}"`}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${title}</title>
<link rel="icon" href="/favicon.svg">
<style>
:root { --bg: #f7f8f5; --panel: #fff; --text: #293d35; --muted: #626e65; --line: #e8ece6;
  --green: #3f6550; --green-soft: #eaf1e9; --danger: #b3261e; --danger-text: #fff;
  font-family: 'Inter', 'Avenir Next', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
  color: var(--text); background: var(--bg); color-scheme: light; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']) { --bg: #17221e; --panel: #202e27; --text: #e4ece4; --muted: #a1aea3;
    --line: #34443a; --green: #aac6ac; --green-soft: #31483b; --danger: #f2b8b5; --danger-text: #601410;
    color-scheme: dark; }
}
:root[data-theme='dark'] { --bg: #17221e; --panel: #202e27; --text: #e4ece4; --muted: #a1aea3;
  --line: #34443a; --green: #aac6ac; --green-soft: #31483b; --danger: #f2b8b5; --danger-text: #601410;
  color-scheme: dark; }
body { margin: 0; background: var(--bg); }
main { max-width: 960px; margin: 0 auto; padding: 20px 16px 48px; }
h1 { margin: 0; font-size: 1.6rem; }
.muted { color: var(--muted); margin: 0; }
code { font-size: .85em; }
.notice { background: var(--green-soft); color: var(--green); border-radius: 12px; padding: 10px 14px; margin: 0 0 16px; }
ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 12px; }
.panel, .tile, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
.top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 20px; }
.top h1 { display: flex; align-items: center; gap: 10px; font-size: 1.35rem; }
.tools { display: flex; align-items: center; gap: 8px; }
.theme fieldset { display: flex; gap: 2px; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); margin: 0; padding: 3px; }
.theme legend { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.theme button { display: flex; align-items: center; gap: 6px; padding: 5px 10px; border: 0; border-radius: 9px; background: transparent; color: var(--muted); font-size: .85rem; }
.theme svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.theme button[aria-pressed='true'] { background: var(--green-soft); color: var(--green); font-weight: 600; }
.overview { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 0 0 12px; }
.tile { padding: 14px 16px; }
.tile dd { font-size: 1.3rem; }
.tile dd small { display: block; font-size: .8rem; margin-top: 2px; }
.meter { height: 6px; border-radius: 999px; background: var(--line); margin-top: 10px; overflow: hidden; }
.meter span { display: block; height: 100%; min-width: 4px; border-radius: inherit; background: var(--green); }
.meter.full span { background: var(--danger); }
.panel { padding: 14px 16px; }
.panel h2 { margin: 0 0 2px; font-size: 1rem; }
.panel .open { color: var(--green); }
.creation { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 24px; }
.creation > div { flex: 1 1 280px; }
.windows { display: flex; flex-wrap: wrap; gap: 8px; }
.limits { margin-top: 12px; }
.limits-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 24px; }
.limits-head > div { flex: 1 1 280px; }
.limits h3 { margin: 16px 0 6px; font-size: .9rem; }
.bans { gap: 0; }
.bans li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding: 8px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.bans li > span:first-child { font-weight: 600; }
.bans li.alert > span:first-child { color: var(--danger); }
.badge.alert { background: var(--danger); color: var(--danger-text); }
.section { margin: 28px 0 12px; font-size: 1.1rem; }
.card { padding: 16px; }
.card header { display: flex; gap: 12px; align-items: center; }
.card img { border-radius: 50%; flex: none; }
.who { flex: 1; min-width: 0; }
.who h3 { margin: 0; font-size: 1.1rem; overflow-wrap: anywhere; }
.badge { background: var(--green-soft); color: var(--green); border-radius: 999px; padding: 0 8px; font-size: .8rem; }
dl { margin: 0; }
dt { font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
dd small { font-weight: 400; color: var(--muted); }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap: 8px; margin-top: 14px; }
.stats > div { background: var(--bg); border-radius: 10px; padding: 8px 12px; }
.stats dd { font-size: 1.15rem; }
.stats dd small { display: block; font-size: .75rem; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 24px; margin-top: 12px; font-size: .85rem; }
.meta > div { display: flex; align-items: baseline; gap: 6px; }
.meta dt { font-size: inherit; text-transform: none; letter-spacing: 0; }
.meta dd { margin: 0; font-weight: 500; }
.identity { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); font-size: .9rem; }
.identity summary { width: fit-content; color: var(--muted); cursor: pointer; }
.identity summary:hover { color: var(--text); }
.identity > div { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 16px; margin-top: 10px; }
.identity svg { flex: none; width: 148px; height: 148px; border-radius: 8px; }
.identity .id { flex: 1 1 220px; min-width: 0; display: grid; justify-items: start; gap: 8px; }
.identity code { font-size: .95rem; padding: 6px 8px; border-radius: 8px; background: var(--bg); overflow-wrap: anywhere; user-select: all; }
button { font: inherit; border-radius: 10px; padding: 8px 14px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
button:hover { border-color: var(--muted); }
button.danger { background: var(--danger); border-color: var(--danger); color: var(--danger-text); font-weight: 600; }
button.delete { background: transparent; color: var(--danger); padding: 6px 12px; font-size: .9rem; font-weight: 600; }
button.delete:hover { border-color: var(--danger); }
.theme button:hover { color: var(--text); }
dialog { border: 1px solid var(--line); border-radius: 16px; padding: 20px; max-width: min(420px, calc(100vw - 32px)); background: var(--panel); color: var(--text); }
dialog::backdrop { background: #0008; }
dialog h2 { margin: 0 0 8px; font-size: 1.2rem; }
dialog p { margin: 0 0 16px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.login { max-width: 360px; margin: 12vh auto 0; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; padding: 24px; display: grid; gap: 14px; }
.login h1 { font-size: 1.3rem; }
label { display: grid; gap: 4px; font-size: .9rem; color: var(--muted); }
input { font: inherit; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
button.primary { background: var(--green); border-color: var(--green); color: var(--panel); font-weight: 600; }
.error { color: var(--danger); margin: 0; }
.empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 16px; padding: 24px; text-align: center; }
@media (max-width: 560px) {
  .theme button span { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .theme button { padding: 6px 8px; }
}
</style>
</head>
<body>
${body}</body>
</html>`;
}
