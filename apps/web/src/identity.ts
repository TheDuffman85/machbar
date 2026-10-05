import { localUserIdSchema } from '@machbar/shared';
import { newId } from './uuid';

export const localUserIdKey = 'machbar-user-id';

export function getLocalUserId(): string {
  const value = localStorage.getItem(localUserIdKey);
  const saved = localUserIdSchema.safeParse(value);
  if (saved.success) {
    if (value !== saved.data) localStorage.setItem(localUserIdKey, saved.data);
    return saved.data;
  }
  const id = newId();
  localStorage.setItem(localUserIdKey, id);
  return id;
}
