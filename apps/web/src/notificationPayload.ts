export type NotificationPayload = {
  version: 1;
  bindingId: string;
  title: string;
  body: string;
  tag: string;
  expiresAt: number;
};
export function parseNotificationPayload(value: unknown): NotificationPayload | undefined {
  if (!value || typeof value !== 'object') return;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    typeof payload.bindingId !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(payload.bindingId) ||
    typeof payload.title !== 'string' ||
    payload.title.length > 160 ||
    typeof payload.body !== 'string' ||
    payload.body.length > 512 ||
    typeof payload.tag !== 'string' ||
    !payload.tag.startsWith(`${payload.bindingId}:`) ||
    payload.tag.length > 256 ||
    typeof payload.expiresAt !== 'number' ||
    !Number.isFinite(payload.expiresAt)
  )
    return;
  return payload as NotificationPayload;
}
