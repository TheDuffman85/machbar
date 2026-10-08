import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell } from 'lucide-react';
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

export function NotificationsPanel({ userId }: { userId: string }) {
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
    </section>
  );
}
