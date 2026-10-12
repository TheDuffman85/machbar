import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminPreferenceChanges, writePreferenceCookies } from './sharedPreferences';

let storage: Map<string, string>;
let cookies: Map<string, string>;

beforeEach(() => {
  storage = new Map();
  cookies = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal('location', { protocol: 'https:' });
  vi.stubGlobal('document', {
    get cookie() {
      return [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
    },
    set cookie(value: string) {
      const [key, ...rest] = value.split(';')[0]!.split('=');
      cookies.set(key!, rest.join('='));
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('preferences shared with the admin page', () => {
  it('hands the profile choice and timezone to the admin page and adopts only later admin changes', () => {
    const profile = {
      theme: 'dark',
      language: 'de',
      timezone: 'America/Argentina/Buenos_Aires',
    } as const;
    expect(adminPreferenceChanges(profile)).toBeNull();
    writePreferenceCookies(profile);
    expect(cookies.get('machbar_theme')).toBe('dark');
    expect(cookies.get('machbar_language')).toBe('de');
    expect(cookies.get('machbar_timezone')).toBe('America%2FArgentina%2FBuenos_Aires');
    // Another device changed the profile: the cookie still holds what this app wrote.
    expect(adminPreferenceChanges({ ...profile, theme: 'light', language: 'en' })).toBeNull();
    // The admin page changed it since.
    cookies.set('machbar_theme', 'system');
    cookies.set('machbar_language', 'en');
    // The admin page has no timezone control, so the profile's stays.
    cookies.set('machbar_timezone', 'UTC');
    expect(adminPreferenceChanges(profile)).toEqual({ theme: 'system', language: 'en' });
  });

  it('ignores cookie values the app does not know', () => {
    cookies.set('machbar_theme', 'blue');
    cookies.set('machbar_language', 'fr');
    expect(adminPreferenceChanges({ theme: 'dark', language: 'de', timezone: 'UTC' })).toBeNull();
  });
});
