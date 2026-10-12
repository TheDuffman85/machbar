import { preferenceCookies, type Preferences } from '@machbar/shared';

type Shared = Pick<Preferences, 'theme' | 'language' | 'timezone'>;
// Only these can be changed on the admin page.
const allowed: Record<'theme' | 'language', readonly string[]> = {
  theme: ['light', 'dark', 'system'],
  language: ['en', 'de'],
};
// What this browser last wrote, so a different cookie means the admin page changed it since.
const writtenKey = 'machbar:shared-preferences';
const keys = Object.keys(allowed) as (keyof typeof allowed)[];

function cookie(name: string) {
  return document.cookie
    .split('; ')
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function written(): Partial<Shared> {
  try {
    return JSON.parse(localStorage.getItem(writtenKey) ?? '{}') as Partial<Shared>;
  } catch {
    return {};
  }
}

/** Theme and language chosen on the admin page since the app last wrote its own. */
export function adminPreferenceChanges(current: Shared): Partial<Shared> | null {
  const last = written();
  const changes: Partial<Shared> = {};
  for (const key of keys) {
    const value = cookie(preferenceCookies[key]);
    if (value && allowed[key].includes(value) && value !== last[key] && value !== current[key])
      Object.assign(changes, { [key]: value });
  }
  return Object.keys(changes).length ? changes : null;
}

/** Shares the profile's theme, language and timezone with the admin page. */
export function writePreferenceCookies(current: Shared) {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  for (const key of [...keys, 'timezone'] as const)
    document.cookie = `${preferenceCookies[key]}=${encodeURIComponent(current[key])}; Path=/; Max-Age=${365 * 24 * 60 * 60}; SameSite=Strict${secure}`;
  try {
    localStorage.setItem(
      writtenKey,
      JSON.stringify({ theme: current.theme, language: current.language }),
    );
  } catch {
    // Without storage, a later admin change is still adopted while it differs from the profile.
  }
}
