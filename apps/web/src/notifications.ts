import { ApiError, request, syncEntry } from './offline';
import { localUserIdKey } from './identity';
import {
  deviceNotifications,
  updateDeviceNotifications,
  type DeviceBinding,
} from './notificationState';

export type NotificationConfig = { available: boolean; publicKey: string | null };
export function notificationSupport(): string | null {
  if (!window.isSecureContext) return 'NOTIFICATIONS_HTTPS';
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (
    ios &&
    !window.matchMedia('(display-mode: standalone)').matches &&
    !(navigator as Navigator & { standalone?: boolean }).standalone
  )
    return 'NOTIFICATIONS_IOS_INSTALL';
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window) ||
    !('ServiceWorkerRegistration' in window) ||
    !('showNotification' in ServiceWorkerRegistration.prototype)
  )
    return 'NOTIFICATIONS_UNSUPPORTED';
  return null;
}
function checkUser(userId: string) {
  if (localStorage.getItem(localUserIdKey) !== userId) throw new ApiError('ACCOUNT_CHANGED', 409);
}
async function registration() {
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration?.active) throw new ApiError('NOTIFICATION_WORKER_NOT_READY');
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ApiError('NOTIFICATION_WORKER_NOT_READY')), 3000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        if (event.data?.notificationVersion === 1) resolve();
        else reject(new ApiError('NOTIFICATION_WORKER_NOT_READY'));
      };
      registration.active!.postMessage({ type: 'NOTIFICATION_VERSION' }, [channel.port2]);
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
  return registration;
}
function publicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
export async function flushNotificationRemovals() {
  if (!navigator.onLine) return;
  const state = await deviceNotifications();
  for (const binding of state.pendingRemoval) {
    await request('/api/notifications/subscription', {
      method: 'DELETE',
      headers: { 'X-Machbar-User': binding.userId },
      body: JSON.stringify({ bindingId: binding.bindingId }),
    });
    await updateDeviceNotifications((state) => {
      state.pendingRemoval = state.pendingRemoval.filter((b) => b.bindingId !== binding.bindingId);
    });
  }
}

export async function disableDeviceNotifications(
  userId: string,
  strict = false,
  expectedBindingId?: string,
) {
  let removed: DeviceBinding | null = null;
  await updateDeviceNotifications((state) => {
    if (state.active?.userId !== userId) return;
    if (expectedBindingId && state.active.bindingId !== expectedBindingId) return;
    removed = state.active;
    state.pendingRemoval.push(state.active);
    state.active = null;
  });
  if (removed && 'serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration();
    const subscription = await reg?.pushManager?.getSubscription();
    if (subscription) {
      const unsubscribed = await subscription.unsubscribe();
      if (!unsubscribed && strict) throw new ApiError('NOTIFICATION_DELIVERY_FAILED');
    }
    for (const notification of (await reg?.getNotifications()) ?? []) notification.close();
  }
  try {
    await flushNotificationRemovals();
  } catch (error) {
    if (strict) throw error;
  }
}

/** Permission is requested synchronously in the button's gesture, before async setup. */
export async function enableDeviceNotifications(userId: string, config: NotificationConfig) {
  const unsupported = notificationSupport();
  if (unsupported) throw new ApiError(unsupported);
  if (!navigator.onLine) throw new ApiError('ONLINE_REQUIRED');
  if (!config.available || !config.publicKey) throw new ApiError('NOTIFICATIONS_UNAVAILABLE');
  checkUser(userId);
  const permission =
    Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') throw new ApiError('NOTIFICATIONS_BLOCKED');
  await flushNotificationRemovals();
  checkUser(userId);
  // An initial browser profile may still exist only in the offline cache.
  // Commit it before registering a subscription that requires a saved profile.
  await syncEntry();
  checkUser(userId);
  const reg = await registration();
  let subscription = await reg.pushManager.getSubscription();
  const key = publicKeyBytes(config.publicKey);
  if (
    subscription &&
    subscription.options.applicationServerKey &&
    !equalKeys(new Uint8Array(subscription.options.applicationServerKey), key)
  ) {
    await disableDeviceNotifications(userId, true);
    if (await reg.pushManager.getSubscription()) await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  checkUser(userId);
  const result = await request<{ bindingId: string }>('/api/notifications/subscription', {
    method: 'PUT',
    headers: { 'X-Machbar-User': userId },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  const binding = { userId, bindingId: result.bindingId, endpoint: subscription.endpoint };
  // Save a cleanup receipt even if the profile changes during the request.
  await updateDeviceNotifications((state) => {
    if (localStorage.getItem(localUserIdKey) === userId) state.active = binding;
    else state.pendingRemoval.push(binding);
  });
  if (localStorage.getItem(localUserIdKey) !== userId) {
    await flushNotificationRemovals();
    throw new ApiError('ACCOUNT_CHANGED', 409);
  }
}
function equalKeys(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function reconcileDeviceNotifications(userId: string) {
  checkUser(userId);
  const active = (await deviceNotifications()).active;
  checkUser(userId);
  if (active) {
    if (
      active.userId !== userId ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    )
      await disableDeviceNotifications(active.userId, false, active.bindingId);
    else if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const subscription = await reg?.pushManager?.getSubscription();
      if (!subscription || subscription.endpoint !== active.endpoint)
        await disableDeviceNotifications(active.userId, false, active.bindingId);
    }
  }
  await flushNotificationRemovals();
}

export async function testDeviceNotification(userId: string) {
  checkUser(userId);
  const active = (await deviceNotifications()).active;
  if (!active || active.userId !== userId) throw new ApiError('NOTIFICATIONS_DISABLED');
  await request('/api/notifications/test', {
    method: 'POST',
    headers: { 'X-Machbar-User': userId },
    body: JSON.stringify({ bindingId: active.bindingId }),
  });
}
