import { openDB, type DBSchema } from 'idb';

export type DeviceBinding = { userId: string; bindingId: string; endpoint: string };
export type DeviceNotifications = { active: DeviceBinding | null; pendingRemoval: DeviceBinding[] };
interface NotificationDB extends DBSchema {
  device: { key: string; value: DeviceNotifications };
}
const database = () =>
  openDB<NotificationDB>('machbar-notifications', 1, {
    upgrade(db) {
      db.createObjectStore('device');
    },
  });
export async function deviceNotifications(): Promise<DeviceNotifications> {
  const db = await database();
  try {
    return (await db.get('device', 'state')) ?? { active: null, pendingRemoval: [] };
  } finally {
    db.close();
  }
}
export async function updateDeviceNotifications(update: (state: DeviceNotifications) => void) {
  const db = await database();
  try {
    const tx = db.transaction('device', 'readwrite');
    const state = (await tx.store.get('state')) ?? { active: null, pendingRemoval: [] };
    update(state);
    await tx.store.put(state, 'state');
    await tx.done;
  } finally {
    db.close();
  }
}
