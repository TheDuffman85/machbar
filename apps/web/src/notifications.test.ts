import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceNotifications } from './notificationState';

const mock = vi.hoisted(() => ({
  request: vi.fn(),
  state: { active: null, pendingRemoval: [] } as DeviceNotifications,
}));
vi.mock('./offline', () => ({
  request: mock.request,
  syncEntry: async () => {},
  ApiError: class extends Error {
    constructor(
      public code: string,
      public status = 0,
    ) {
      super(code);
    }
  },
}));
vi.mock('./notificationState', () => ({
  deviceNotifications: async () => structuredClone(mock.state),
  updateDeviceNotifications: async (update: (state: DeviceNotifications) => void) => {
    update(mock.state);
  },
}));
import {
  notificationSupport,
  enableDeviceNotifications,
  disableDeviceNotifications,
  reconcileDeviceNotifications,
  testDeviceNotification,
} from './notifications';

const alice = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  bob = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const bindingId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const config = { available: true, publicKey: 'B' + 'A'.repeat(86) };
let currentUser: string, permission: NotificationPermission;
let permissionRequest: ReturnType<typeof vi.fn>;
let subscription: {
  endpoint: string;
  options: object;
  unsubscribe: ReturnType<typeof vi.fn>;
  toJSON: () => object;
} | null;
let reg: {
  active: { postMessage: ReturnType<typeof vi.fn> };
  pushManager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
  getNotifications: ReturnType<typeof vi.fn>;
};
const close = vi.fn();
beforeEach(() => {
  currentUser = alice;
  permission = 'default';
  mock.state = { active: null, pendingRemoval: [] };
  mock.request.mockReset();
  close.mockReset();
  mock.request.mockImplementation(async (path: string) =>
    path.endsWith('/subscription') ? { bindingId } : { ok: true },
  );
  permissionRequest = vi.fn(async () => {
    permission = 'granted';
    return permission;
  });
  const notifications = {
    get permission() {
      return permission;
    },
    requestPermission: permissionRequest,
  };
  class WorkerRegistration {
    showNotification() {}
  }
  vi.stubGlobal('ServiceWorkerRegistration', WorkerRegistration);
  vi.stubGlobal('Notification', notifications);
  vi.stubGlobal('window', {
    isSecureContext: true,
    Notification: notifications,
    ServiceWorkerRegistration: WorkerRegistration,
    PushManager: {},
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('localStorage', { getItem: () => currentUser });
  subscription = null;
  const subscribe = vi.fn(async () => {
    subscription = {
      endpoint: 'https://push.example.com/one',
      options: {},
      unsubscribe: vi.fn(async () => {
        subscription = null;
        return true;
      }),
      toJSON: () => ({
        endpoint: 'https://push.example.com/one',
        keys: { p256dh: config.publicKey, auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
      }),
    };
    return subscription;
  });
  reg = {
    active: {
      postMessage: vi.fn((_message: unknown, ports: MessagePort[]) => {
        ports[0]!.postMessage({ notificationVersion: 1 });
      }),
    },
    pushManager: { getSubscription: vi.fn(async () => subscription), subscribe },
    getNotifications: vi.fn(async () => [{ close }]),
  };
  vi.stubGlobal('navigator', {
    onLine: true,
    userAgent: 'Chrome',
    platform: 'Linux',
    maxTouchPoints: 0,
    serviceWorker: { getRegistration: vi.fn(async () => reg) },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('device notification lifecycle', () => {
  it('requests permission directly from enable and saves the server binding', async () => {
    const operation = enableDeviceNotifications(alice, config);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
    expect(mock.request).not.toHaveBeenCalled();
    await operation;
    expect(mock.state.active).toMatchObject({ userId: alice, bindingId });
    expect(reg.pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    expect(mock.request).toHaveBeenCalledWith(
      '/api/notifications/subscription',
      expect.objectContaining({ method: 'PUT', headers: { 'X-Machbar-User': alice } }),
    );
  });
  it('does not ask permission during reconciliation or when offline/unconfigured', async () => {
    await reconcileDeviceNotifications(alice);
    expect(permissionRequest).not.toHaveBeenCalled();
    await expect(
      enableDeviceNotifications(alice, { available: false, publicKey: null }),
    ).rejects.toMatchObject({ code: 'NOTIFICATIONS_UNAVAILABLE' });
    Object.defineProperty(navigator, 'onLine', { value: false });
    await expect(enableDeviceNotifications(alice, config)).rejects.toMatchObject({
      code: 'ONLINE_REQUIRED',
    });
    expect(permissionRequest).not.toHaveBeenCalled();
  });
  it('handles denied permission without subscribing', async () => {
    permissionRequest.mockResolvedValue('denied');
    await expect(enableDeviceNotifications(alice, config)).rejects.toMatchObject({
      code: 'NOTIFICATIONS_BLOCKED',
    });
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('disables locally offline, unsubscribes, closes alerts, then cleans up with the original identity', async () => {
    await enableDeviceNotifications(alice, config);
    mock.request.mockClear();
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await disableDeviceNotifications(alice);
    expect(mock.state.active).toBeNull();
    expect(mock.state.pendingRemoval).toHaveLength(1);
    expect(subscription).toBeNull();
    expect(close).toHaveBeenCalled();
    expect(mock.request).not.toHaveBeenCalled();
    Object.defineProperty(navigator, 'onLine', { value: true });
    currentUser = bob;
    await reconcileDeviceNotifications(bob);
    expect(mock.request).toHaveBeenCalledWith(
      '/api/notifications/subscription',
      expect.objectContaining({ method: 'DELETE', headers: { 'X-Machbar-User': alice } }),
    );
    expect(mock.state.pendingRemoval).toEqual([]);
    expect(permissionRequest).toHaveBeenCalledTimes(1);
  });
  it('clears old profile bindings and revoked permission without automatically enrolling a new profile', async () => {
    await enableDeviceNotifications(alice, config);
    currentUser = bob;
    await reconcileDeviceNotifications(bob);
    expect(mock.state.active).toBeNull();
    await expect(testDeviceNotification(bob)).rejects.toMatchObject({
      code: 'NOTIFICATIONS_DISABLED',
    });
    currentUser = alice;
    await enableDeviceNotifications(alice, config);
    permission = 'denied';
    await reconcileDeviceNotifications(alice);
    expect(mock.state.active).toBeNull();
  });
  it('cleans up a registration if identity changes during the server request', async () => {
    mock.request.mockImplementation(async (_path: string, options: RequestInit) => {
      if (options.method === 'PUT') {
        currentUser = bob;
        return { bindingId };
      }
      return { ok: true };
    });
    await expect(enableDeviceNotifications(alice, config)).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });
    expect(mock.state.active).toBeNull();
    expect(mock.state.pendingRemoval).toEqual([]);
    expect(mock.request).toHaveBeenCalledWith(
      '/api/notifications/subscription',
      expect.objectContaining({ method: 'DELETE', headers: { 'X-Machbar-User': alice } }),
    );
  });
  it('requires the updated service worker and times out the version handshake', async () => {
    vi.useFakeTimers();
    reg.active.postMessage.mockImplementation(() => {});
    const failure = expect(enableDeviceNotifications(alice, config)).rejects.toMatchObject({
      code: 'NOTIFICATION_WORKER_NOT_READY',
    });
    await vi.advanceTimersByTimeAsync(3000);
    await failure;
    expect(reg.pushManager.subscribe).not.toHaveBeenCalled();
  });
  it('explains insecure origins and iOS browser installation requirements', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    expect(notificationSupport()).toBe('NOTIFICATIONS_HTTPS');
    Object.defineProperty(window, 'isSecureContext', { value: true });
    Object.defineProperty(navigator, 'userAgent', { value: 'iPhone Safari' });
    expect(notificationSupport()).toBe('NOTIFICATIONS_IOS_INSTALL');
    Object.defineProperty(navigator, 'standalone', { value: true });
    expect(notificationSupport()).toBeNull();
    delete (window as unknown as { PushManager?: unknown }).PushManager;
    expect(notificationSupport()).toBe('NOTIFICATIONS_UNSUPPORTED');
  });
  it('does not let a stale tab reconcile another active profile', async () => {
    currentUser = bob;
    mock.state.active = { userId: bob, bindingId, endpoint: 'https://push.example.com/one' };
    await expect(reconcileDeviceNotifications(alice)).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });
    expect(mock.state.active?.userId).toBe(bob);
    expect(mock.request).not.toHaveBeenCalled();
  });
});
