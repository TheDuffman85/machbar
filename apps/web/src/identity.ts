import { localUserIdSchema } from '@machbar/shared';
import { newId } from './uuid';

export const localUserIdKey = 'machbar-user-id';

function cookieUserId(): string | undefined {
  try {
    const cookie = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${localUserIdKey}=`));
    const saved = localUserIdSchema.safeParse(
      cookie ? decodeURIComponent(cookie.slice(localUserIdKey.length + 1)) : undefined,
    );
    return saved.success ? saved.data : undefined;
  } catch {
    return undefined;
  }
}

function saveCookieUserId(id: string): void {
  try {
    // iOS copies cookies, but not localStorage, when installing a Home Screen app.
    // Keep this host-only and readable so the new app can restore its local ID.
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${localUserIdKey}=${id}; Path=/; Max-Age=31536000; SameSite=Strict${secure}`;
  } catch {
    // Cookie restrictions must not prevent normal localStorage-backed use.
  }
}

export function setLocalUserId(id: string): void {
  const saved = localUserIdSchema.parse(id);
  localStorage.setItem(localUserIdKey, saved);
  saveCookieUserId(saved);
}

export function getLocalUserId(): string {
  const value = localStorage.getItem(localUserIdKey);
  const saved = localUserIdSchema.safeParse(value);
  if (saved.success) {
    if (value !== saved.data) localStorage.setItem(localUserIdKey, saved.data);
    saveCookieUserId(saved.data);
    return saved.data;
  }
  const id = cookieUserId() ?? newId();
  setLocalUserId(id);
  return id;
}
