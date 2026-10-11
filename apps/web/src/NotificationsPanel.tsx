import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
import { defaultCheckInReminderTime, type Preferences } from '@machbar/shared';
import { ApiError, request } from './offline';
import { deviceNotifications } from './notificationState';
import {
  disableDeviceNotifications,
  enableDeviceNotifications,
  notificationSupport,
  reconcileDeviceNotifications,
  testDeviceNotification,
  type NotificationConfig,
} from './notifications';

export function NotificationsPanel({
  userId,
  preferences,
  onUpdate,
}: {
  userId: string;
  preferences: Preferences;
  onUpdate: (patch: Partial<Preferences>) => void;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const support = notificationSupport();
  const permission = 'Notification' in window ? Notification.permission : 'default';
  async function refresh() {
    await reconcileDeviceNotifications(userId);
    setEnabled((await deviceNotifications()).active?.userId === userId);
    if (navigator.onLine) setConfig(await request<NotificationConfig>('/api/notifications/config'));
  }
  useEffect(() => {
    let disposed = false;
    const refreshSafe = () => {
      if (disposed) return;
      void refresh().catch((error: unknown) => {
        if (!disposed) setError(error instanceof ApiError ? error.code : 'INTERNAL_ERROR');
      });
    };
    refreshSafe();
    window.addEventListener('online', refreshSafe);
    window.addEventListener('focus', refreshSafe);
    return () => {
      disposed = true;
      window.removeEventListener('online', refreshSafe);
      window.removeEventListener('focus', refreshSafe);
    };
  }, [userId]);
  async function run(operation: Promise<void>, success = '') {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await operation;
      setMessage(success);
    } catch (error) {
      setError(error instanceof ApiError ? error.code : 'NOTIFICATION_DELIVERY_FAILED');
    } finally {
      setEnabled((await deviceNotifications()).active?.userId === userId);
      setBusy(false);
    }
  }
  return (
    <section className="panel settings-panel">
      <span className="settings-feature-icon">
        <Bell size={24} />
      </span>
      <h2>{t('notifications')}</h2>
      <p>{t('notificationsHelp')}</p>
      <p className="form-hint">{t('notificationsOfflineHint')}</p>
      <p role="status">
        {t(enabled ? 'notificationsEnabled' : 'notificationsDisabled')} ·{' '}
        {t(`notificationPermission_${permission}`)}
      </p>
      {support && <p className="form-hint">{t(support)}</p>}
      {!support && config && !config.available && (
        <p className="form-hint">{t('NOTIFICATIONS_UNAVAILABLE')}</p>
      )}
      {!navigator.onLine && <p className="form-hint">{t('ONLINE_REQUIRED')}</p>}
      <div className="form-actions">
        {enabled ? (
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={() => void run(disableDeviceNotifications(userId))}
          >
            {t('disableNotifications')}
          </button>
        ) : (
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              !!support ||
              !config?.available ||
              !navigator.onLine ||
              permission === 'denied'
            }
            onClick={() => void run(enableDeviceNotifications(userId, config!))}
          >
            {t('enableNotifications')}
          </button>
        )}
        {enabled && (
          <button
            type="button"
            className="button secondary"
            disabled={busy || !config?.available || !navigator.onLine}
            onClick={() => void run(testDeviceNotification(userId), 'notificationTestSent')}
          >
            {t('testNotification')}
          </button>
        )}
      </div>
      {permission === 'denied' && <p className="form-hint">{t('NOTIFICATIONS_BLOCKED')}</p>}
      {error && <p role="alert">{t(error)}</p>}
      {message && <p role="status">{t(message)}</p>}
      <CheckInReminder preferences={preferences} onUpdate={onUpdate} />
    </section>
  );
}

/** Profile-wide, so it follows the profile to every device with notifications enabled. */
function CheckInReminder({
  preferences,
  onUpdate,
}: {
  preferences: Preferences;
  onUpdate: (patch: Partial<Preferences>) => void;
}) {
  const { t } = useTranslation();
  const savedEnabled = preferences.checkInReminder !== false;
  const saved = preferences.checkInReminderTime ?? defaultCheckInReminderTime;
  // Saving is asynchronous, and time inputs report an empty value while partially
  // edited, so show local drafts until the saved preferences change.
  const [enabled, setEnabled] = useState(savedEnabled);
  const [time, setTime] = useState(saved);
  useEffect(() => setEnabled(savedEnabled), [savedEnabled]);
  useEffect(() => setTime(saved), [saved]);
  return (
    <form className="check-in-form" onSubmit={(e) => e.preventDefault()}>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            onUpdate({ checkInReminder: e.target.checked });
          }}
        />
        {t('checkInReminder')}
      </label>
      {enabled && (
        <label>
          {t('checkInReminderTime')}
          <input
            type="time"
            aria-label={t('checkInReminderTime')}
            required
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              if (/^\d{2}:\d{2}$/.test(e.target.value) && e.target.value !== saved)
                onUpdate({ checkInReminderTime: e.target.value });
            }}
          />
          <span className="form-hint">
            {t('checkInReminderHint', { timezone: preferences.timezone })}
          </span>
        </label>
      )}
    </form>
  );
}
