import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { SproutArt } from './Plant';
import { EntityIcon, IconPicker } from './EntityIcon';
import { UserIdentity } from './UserIdentity';
import { localUserIdKey } from './identity';
import { lockPageScroll } from './scrollLock';
import { buildInfo } from './buildInfo';
import { Avatar } from './Avatar';
import { AvatarEditor, type AvatarValue } from './AvatarEditor';
import { NotificationsPanel } from './NotificationsPanel';
import {
  enableDeviceNotifications,
  notificationSupport,
  reconcileDeviceNotifications,
  type NotificationConfig,
} from './notifications';
import { deviceNotifications } from './notificationState';
import { noAutofill } from './noAutofill';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Flame,
  Gift as GiftIcon,
  Leaf,
  Moon,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Sun,
  Target,
  Trophy,
  X,
  Pencil,
  Archive,
  Bell,
  RefreshCw,
  Download,
  Lock,
  CalendarDays,
  Heart,
  QrCode,
  type LucideIcon,
} from 'lucide-react';
import {
  addDays,
  completionKey,
  operationKey,
  occurrenceFor,
  isPeriodHabit,
  alignAnchor,
  scheduleChangeDate,
  type HabitSchedule,
  type EntityIcon as IconName,
  type Recurrence,
  localDate,
  scheduled,
  scheduleFor,
  same,
  type Bootstrap,
  type CompletionOperation,
  type Goal,
  type Habit,
  type Step,
  type Preferences,
  type Gift,
} from '@machbar/shared';
import {
  ApiError,
  discardQueue,
  loadEntry,
  loadSyncLog,
  subscribeSyncLog,
  syncEntry,
  subscribeEntries,
  mutate,
  request,
  startNewProfile,
  switchLocalUser,
  toggleCompletion,
  visibleSnapshot,
  type Entry,
} from './offline';

const isProfileDeleted = (error: unknown) =>
  error instanceof ApiError && error.code === 'PROFILE_DELETED';

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};
type ModalState =
  | { kind: 'habit'; habit?: Habit }
  | { kind: 'goal'; goal?: Goal }
  | { kind: 'step'; goal: Goal; step?: Step }
  | { kind: 'gift' }
  | { kind: 'install' }
  | {
      kind: 'avatar';
      initial: AvatarValue;
      draft?: boolean;
      onApply?: (value: AvatarValue) => void;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      confirmLabel: string;
      onConfirm: () => void | Promise<unknown>;
    }
  | null;
type AppContext = {
  snapshot: Bootstrap;
  entry: Entry;
  online: boolean;
  busy: boolean;
  syncing: boolean;
  sync: () => Promise<void>;
  action: (path: string, method: string, body?: unknown) => Promise<boolean>;
  errorCode: string;
  toggle: (
    type: CompletionOperation['targetType'],
    id: string,
    date: string,
    timezone: string,
  ) => Promise<void>;
  setModal: (state: ModalState) => void;
  notify: (message: string) => void;
  install: () => Promise<void>;
  changeUser: (userId: string) => Promise<void>;
};
const Context = createContext<AppContext | null>(null);
function useApp() {
  return useContext(Context)!;
}
// The plugin's updateServiceWorker only reloads when the page was controlled at registration
// and silently does nothing without a waiting worker, so activate and reload explicitly.
async function applyUpdate() {
  const waiting = (await navigator.serviceWorker?.getRegistration())?.waiting;
  if (!waiting) {
    window.location.reload();
    return;
  }
  const reload = () => window.location.reload();
  navigator.serviceWorker.addEventListener('controllerchange', reload, { once: true });
  waiting.addEventListener('statechange', () => waiting.state === 'activated' && reload());
  waiting.postMessage({ type: 'SKIP_WAITING' });
}
function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone
  );
}
const hintKey = (hint: 'install' | 'notifications') => `machbar-hint-${hint}`;
function hintSeen(hint: 'install' | 'notifications') {
  try {
    return localStorage.getItem(hintKey(hint)) !== null;
  } catch {
    return true;
  }
}
function markHintSeen(hint: 'install' | 'notifications') {
  try {
    localStorage.setItem(hintKey(hint), '1');
  } catch {
    // Without storage the hint simply shows again next session.
  }
}
// One-time banners for installing the app and enabling notifications, shown one at a time.
function SetupHints() {
  const { t } = useTranslation();
  const { snapshot, install, notify, online } = useApp();
  const userId = snapshot.document.userId;
  const [showInstall, setShowInstall] = useState(() => !hintSeen('install') && !isStandalone());
  const [notificationConfig, setNotificationConfig] = useState<NotificationConfig | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (
      showInstall ||
      !online ||
      hintSeen('notifications') ||
      notificationSupport() ||
      Notification.permission !== 'default'
    )
      return;
    let disposed = false;
    void (async () => {
      if ((await deviceNotifications()).active?.userId === userId) return;
      const config = await request<NotificationConfig>('/api/notifications/config');
      if (!disposed && config.available && config.publicKey) setNotificationConfig(config);
    })().catch(() => {});
    return () => {
      disposed = true;
    };
  }, [showInstall, online, userId]);
  function dismissInstall() {
    markHintSeen('install');
    setShowInstall(false);
  }
  function dismissNotifications() {
    markHintSeen('notifications');
    setNotificationConfig(null);
  }
  async function enableNotifications() {
    setBusy(true);
    try {
      await enableDeviceNotifications(userId, notificationConfig!);
      notify(t('notificationsEnabled'));
    } catch (error) {
      notify(t(error instanceof ApiError ? error.code : 'NOTIFICATION_DELIVERY_FAILED'));
    } finally {
      setBusy(false);
      dismissNotifications();
    }
  }
  if (showInstall)
    return (
      <div className="notice" role="status">
        <div>
          <Download size={18} />
          <span>{t('installHint')}</span>
        </div>
        <div>
          <button
            onClick={() => {
              dismissInstall();
              void install();
            }}
          >
            {t('installShort')}
          </button>
          <button aria-label={t('close')} onClick={dismissInstall}>
            <X size={16} />
          </button>
        </div>
      </div>
    );
  if (notificationConfig)
    return (
      <div className="notice" role="status">
        <div>
          <Bell size={18} />
          <span>{t('notificationsHint')}</span>
        </div>
        <div>
          <button disabled={busy} onClick={() => void enableNotifications()}>
            {t('enableShort')}
          </button>
          <button aria-label={t('close')} disabled={busy} onClick={dismissNotifications}>
            <X size={16} />
          </button>
        </div>
      </div>
    );
  return null;
}
const colors = ['sage', 'peach', 'lavender', 'blue'] as const;
const badgeDefinitions = [
  ['wins-1', 'badgeWins1', 'badgeWinsDescription', 1, Leaf],
  ['wins-10', 'badgeWins10', 'badgeWinsDescription', 10, Sparkles],
  ['wins-50', 'badgeWins50', 'badgeWinsDescription', 50, Heart],
  ['wins-100', 'badgeWins100', 'badgeWinsDescription', 100, Trophy],
  ['first-goal', 'badgeGoal', 'badgeGoalDescription', 1, Target],
  ['streak-3', 'badgeStreak3', 'badgeStreakDescription', 3, Flame],
  ['streak-7', 'badgeStreak7', 'badgeStreakDescription', 7, Sun],
  ['streak-30', 'badgeStreak30', 'badgeStreakDescription', 30, CircleCheck],
] as const;

function Brand() {
  return (
    <div className="brand">
      <span className="brand-icon">
        <Check size={25} strokeWidth={3} />
        <i />
      </span>
      <span>
        machbar<span className="brand-dot">.</span>
      </span>
    </div>
  );
}
function ProfileMenu() {
  const { t } = useTranslation();
  const { snapshot } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location, snapshot.document.userId]);
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    // Safari can blur a menu item with no relatedTarget during a tap. Wait for
    // actual focus outside the menu so its links survive until their click.
    document.addEventListener('focusin', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('focusin', dismiss);
    };
  }, [open]);
  return (
    <div
      className="profile-menu"
      ref={ref}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && open) {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          if (!open) {
            setOpen(true);
            return;
          }
          const items = Array.from(
            ref.current!.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
          );
          const index = items.indexOf(document.activeElement as HTMLElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        className="profile-menu-trigger"
        aria-label={t('profileMenu')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'profile-menu' : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <Avatar
          seed={snapshot.document.preferences.avatarSeed}
          options={snapshot.document.preferences.avatarOptions}
          size={36}
        />
      </button>
      {open && (
        <div
          id="profile-menu"
          className="profile-menu-panel"
          role="menu"
          aria-label={t('profileMenu')}
        >
          <NavLink to="/settings" role="menuitem" onClick={() => setOpen(false)}>
            <SettingsIcon size={17} />
            {t('settings')}
          </NavLink>
          <NavLink to="/user-id" role="menuitem" onClick={() => setOpen(false)}>
            <QrCode size={17} />
            {t('userIdentity')}
          </NavLink>
        </div>
      )}
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
  dismissible = true,
  role = 'dialog',
  description,
  className = '',
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  dismissible?: boolean;
  role?: 'dialog' | 'alertdialog';
  description?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const { t } = useTranslation();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    const unlockScroll = lockPageScroll();
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      dialog?.close();
      unlockScroll();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected)
        previousFocus.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${className}`}
      role={role}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === e.currentTarget) onClose();
      }}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
    >
      <div className="modal-heading">
        <h2 id={`${id}-title`}>{title}</h2>
        <>
          {dismissible && (
            <button className="icon-button" aria-label={t('close')} onClick={onClose}>
              <X size={20} />
            </button>
          )}
        </>
      </div>
      {description && (
        <p id={`${id}-description`} className="modal-description">
          {description}
        </p>
      )}
      {children}
    </dialog>
  );
}
function Empty({
  title,
  description,
  icon: Icon = Leaf,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={29} />
      </div>
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}
function Bar({
  value,
  max = 100,
  className = '',
}: {
  value: number;
  max?: number;
  className?: string;
}) {
  return (
    <div
      className={`progress-track ${className}`}
      role="progressbar"
      aria-label={useTranslation().t('progress')}
      aria-valuenow={Math.min(value, max)}
      aria-valuemin={0}
      aria-valuemax={max || 1}
    >
      <span style={{ width: `${max ? Math.min(100, (value / max) * 100) : 0}%` }} />
    </div>
  );
}

export function App() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['machbar'], queryFn: loadEntry, networkMode: 'always' });
  const [online, setOnline] = useState(navigator.onLine);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);
  useEffect(() => {
    const capture = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as InstallPrompt);
    };
    window.addEventListener('beforeinstallprompt', capture);
    return () => window.removeEventListener('beforeinstallprompt', capture);
  }, []);
  const install = async () => {
    if (!installPrompt) {
      setModal({ kind: 'install' });
      return;
    }
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };
  const [busy, setBusy] = useState(false),
    [syncing, setSyncing] = useState(false);
  const [modal, setModal] = useState<ModalState>(null),
    [toast, setToast] = useState(''),
    [error, setError] = useState('');
  const [themePreview, setThemePreview] = useState<{
    userId: string;
    theme: Preferences['theme'];
  } | null>(null);
  const syncingRef = useRef(false);
  const syncTimerRef = useRef<number | undefined>(undefined);
  const syncRef = useRef<() => Promise<void>>(async () => {});
  const entryRef = useRef<Entry | undefined>(undefined);
  const syncRequestedRef = useRef(false);
  const retryDelayRef = useRef(5_000);
  const {
    needRefresh: [needRefresh],
  } = useRegisterSW();
  const entry = query.data;
  entryRef.current = entry;
  const snapshot = entry ? visibleSnapshot(entry) : undefined;
  const preferences = snapshot?.document.preferences;
  useEffect(() => {
    const userId = snapshot?.document.userId;
    if (!userId) return;
    const reconcile = () => {
      void reconcileDeviceNotifications(userId).catch(() => {});
    };
    reconcile();
    window.addEventListener('online', reconcile);
    window.addEventListener('focus', reconcile);
    return () => {
      window.removeEventListener('online', reconcile);
      window.removeEventListener('focus', reconcile);
    };
  }, [snapshot?.document.userId]);
  const theme =
    themePreview && !preferences?.onboarded && themePreview.userId === snapshot?.document.userId
      ? themePreview.theme
      : preferences?.theme;
  const location = useLocation();
  useEffect(() => {
    setModal(null);
    setToast('');
    setError('');
    setThemePreview(null);
  }, [snapshot?.document.userId]);
  const sync = async () => {
    if (!navigator.onLine) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = window.setTimeout(() => void syncRef.current(), 5_000);
      return;
    }
    if (syncingRef.current) {
      syncRequestedRef.current = true;
      return;
    }
    const syncingUserId = localStorage.getItem(localUserIdKey);
    clearTimeout(syncTimerRef.current);
    syncRequestedRef.current = false;
    syncingRef.current = true;
    setSyncing(true);
    let succeeded = false;
    let deleted = false;
    try {
      const next = await syncEntry();
      succeeded = true;
      retryDelayRef.current = 5_000;
      if (next.snapshot.document.userId === localStorage.getItem(localUserIdKey))
        queryClient.setQueryData(['machbar'], next);
    } catch (e) {
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, 60_000);
      // Background network failures are recorded in the log. Local storage
      // failures still need attention because they also affect local saves.
      if (
        syncingUserId === localStorage.getItem(localUserIdKey) &&
        e instanceof ApiError &&
        e.code === 'STORAGE_UNAVAILABLE'
      )
        setError(e.code);
      // The server deleted this profile. Its local copy is gone; reload to show
      // the deletion screen instead of retrying in the background.
      if (syncingUserId === localStorage.getItem(localUserIdKey) && isProfileDeleted(e)) {
        deleted = true;
        void queryClient.resetQueries({ queryKey: ['machbar'] });
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      // Coalesce new edits after a successful upload. A failure must yield to
      // the retry backoff instead of immediately restarting a stalled sync.
      const userChanged = syncingUserId !== localStorage.getItem(localUserIdKey);
      if (userChanged) retryDelayRef.current = 5_000;
      if ((succeeded || userChanged) && syncRequestedRef.current) void syncRef.current();
      else if (deleted) syncRequestedRef.current = false;
      else {
        syncRequestedRef.current = false;
        syncTimerRef.current = window.setTimeout(
          () => void syncRef.current(),
          succeeded && !entryRef.current?.queue.length
            ? document.hidden
              ? 60_000
              : 5_000
            : retryDelayRef.current,
        );
      }
    }
  };
  syncRef.current = sync;
  useEffect(() => {
    const reconnect = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void sync();
    };
    const foreground = () => {
      if (!document.hidden) void syncRef.current();
    };
    const readLocal = async () => {
      try {
        const next = await loadEntry();
        if (next.snapshot.document.userId === localStorage.getItem(localUserIdKey)) {
          queryClient.setQueryData(['machbar'], next);
          return next;
        }
      } catch (e) {
        if (isProfileDeleted(e)) void queryClient.resetQueries({ queryKey: ['machbar'] });
        else setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
      }
    };
    const identityChanged = (event: StorageEvent) => {
      if (event.key === localUserIdKey)
        void readLocal().then(() => {
          if (navigator.onLine) void sync();
        });
    };
    const unsubscribe = subscribeEntries(() => {
      void readLocal().then((next) => {
        // Another window's local edits also deserve a prompt upload. A sync
        // acknowledgment has no queue and must not create a refresh loop.
        if (next?.queue.length) void syncRef.current();
      });
    });
    if (entry) void syncRef.current();
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', reconnect);
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('focus', foreground);
    window.addEventListener('storage', identityChanged);
    // Refresh calendar/progress at midnight in the profile's timezone.
    const clock = window.setInterval(() => {
      if (entry)
        queryClient.setQueryData<Entry>(['machbar'], (current) =>
          current ? { ...current, snapshot: visibleSnapshot(current) } : current,
        );
    }, 30_000);
    return () => {
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', reconnect);
      document.removeEventListener('visibilitychange', foreground);
      window.removeEventListener('focus', foreground);
      window.removeEventListener('storage', identityChanged);
      window.clearTimeout(syncTimerRef.current);
      window.clearInterval(clock);
      unsubscribe();
    };
  }, [entry?.snapshot.document.userId]);
  useEffect(() => {
    if (toast) {
      const timer = window.setTimeout(() => setToast(''), 3500);
      return () => window.clearTimeout(timer);
    }
  }, [toast]);
  useEffect(() => {
    if (preferences?.onboarded) void i18n.changeLanguage(preferences.language);
    document.documentElement.lang = preferences?.onboarded ? preferences.language : i18n.language;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      document.documentElement.classList.toggle(
        'dark',
        theme === 'dark' || (theme !== 'light' && media.matches),
      );
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme, preferences?.language, preferences?.onboarded, i18n]);
  useEffect(() => {
    document.title = `Machbar — ${t('tagline')}`;
  }, [t, i18n.language]);
  async function action(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError('');
    try {
      queryClient.setQueryData(
        ['machbar'],
        await mutate(path, method, body, snapshot?.document.userId),
      );
      if (navigator.onLine) void sync();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
      if (e instanceof ApiError && e.status === 409) void sync();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function toggle(
    type: CompletionOperation['targetType'],
    id: string,
    date: string,
    timezone: string,
  ) {
    if (!snapshot) return;
    try {
      const next = await toggleCompletion(type, id, date, timezone, snapshot.document.userId);
      queryClient.setQueryData(['machbar'], next);
      if (navigator.onLine) void sync();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
    }
  }
  async function changeUser(userId: string) {
    if (busy) return;
    setBusy(true);
    try {
      queryClient.setQueryData(['machbar'], await switchLocalUser(userId));
      void sync();
    } finally {
      setBusy(false);
    }
  }
  const notifications = (
    <>
      {toast && (
        <div className="toast" role="status">
          <Sparkles size={19} />
          {toast}
        </div>
      )}
    </>
  );
  if (!entry || !snapshot) {
    if (isProfileDeleted(query.error)) {
      return (
        <main className="profile-selection">
          <Brand />
          <p className="muted">{t('PROFILE_DELETED')}</p>
          {error && <p role="alert">{t(error)}</p>}
          <button
            className="button primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await startNewProfile();
                await queryClient.resetQueries({ queryKey: ['machbar'] });
                void sync();
              } catch (e) {
                setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('startNewProfile')}
          </button>
          <UserIdentity
            userId={null}
            disabled={busy || !online}
            pending={false}
            onSwitch={changeUser}
          />
        </main>
      );
    }
    if (query.error instanceof ApiError && query.error.code === 'USER_CREATION_DISABLED') {
      return (
        <main className="profile-selection">
          <Brand />
          <p className="muted">{t('USER_CREATION_DISABLED')}</p>
          <UserIdentity
            userId={null}
            disabled={busy || !online}
            pending={false}
            onSwitch={changeUser}
          />
        </main>
      );
    }
    return (
      <main className="welcome-screen">
        <Brand />
        <SproutArt />
        <h1>{query.isPending ? t('loading') : t('INTERNAL_ERROR')}</h1>
        <p>{query.error instanceof ApiError ? t(query.error.code) : t('tagline')}</p>
        {!query.isPending && (
          <button className="button primary" onClick={() => void query.refetch()}>
            {t('retry')}
          </button>
        )}
      </main>
    );
  }
  const context: AppContext = {
    errorCode: error,
    snapshot,
    entry,
    online,
    busy,
    syncing,
    sync,
    action,
    toggle,
    setModal: (state) => {
      setModal(state);
      setError('');
    },
    notify: setToast,
    install,
    changeUser,
  };
  const nav = [
    { path: '/', key: 'today', icon: Sun },
    { path: '/habits', key: 'habits', icon: Leaf },
    { path: '/goals', key: 'goals', icon: Target },
    { path: '/rewards', key: 'rewards', icon: GiftIcon },
  ];
  return (
    <Context.Provider value={context}>
      <div className="app-shell">
        <aside className="sidebar" aria-label={t('navigation')}>
          <Brand />
          <p className="brand-tagline">{t('tagline')}</p>
          <nav aria-label={t('navigation')}>
            {nav.map(({ path, key, icon: Icon }) => (
              <NavLink key={key} to={path} end={path === '/'}>
                <Icon size={21} />
                <span>{t(key)}</span>
              </NavLink>
            ))}
          </nav>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <span className="mobile-brand">
              <Brand />
            </span>
            <div className="topbar-right">
              <span className="level-pill">
                <Sparkles size={15} />
                {t('level', { level: snapshot.progress.level })}
              </span>
              <ProfileMenu />
            </div>
          </header>
          <main className="main-content">
            <div className="notifications">
              {notifications}
              {entry.conflict && (
                <div className="notice" role="status">
                  <div>
                    <RefreshCw size={18} />
                    <span>{t('conflict')}</span>
                  </div>
                  <button
                    disabled={busy || !online}
                    onClick={() =>
                      setModal({
                        kind: 'confirm',
                        title: t('discard'),
                        message: t('discardConfirm'),
                        confirmLabel: t('discard'),
                        onConfirm: async () => {
                          setBusy(true);
                          setError('');
                          try {
                            queryClient.setQueryData(['machbar'], await discardQueue());
                          } catch (e) {
                            setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
                          } finally {
                            setBusy(false);
                          }
                        },
                      })
                    }
                  >
                    {t('discard')}
                  </button>
                </div>
              )}
              {needRefresh && (
                <div className="notice">
                  <span>{t(entry.queue.length ? 'updatePending' : 'updateReady')}</span>
                  <button disabled={entry.queue.length > 0} onClick={() => void applyUpdate()}>
                    {t('update')}
                  </button>
                </div>
              )}
              {!needRefresh && preferences!.onboarded && (
                <SetupHints key={snapshot.document.userId} />
              )}
            </div>
            <Routes>
              <Route
                path="/"
                element={<Today key={`${location.key}:${snapshot.document.userId}`} />}
              />
              <Route path="/goals" element={<Goals />} />
              <Route path="/habits" element={<Habits />} />
              <Route path="/rewards" element={<Rewards />} />
              <Route path="/settings" element={<Settings />} />
              <Route
                path="/settings/sync-log"
                element={<SyncLog key={snapshot.document.userId} />}
              />
              <Route
                path="/user-id"
                element={
                  <UserIdentity
                    key={snapshot.document.userId}
                    userId={snapshot.document.userId}
                    disabled={busy || !online || entry.queue.length > 0}
                    pending={entry.queue.length > 0}
                    onSwitch={changeUser}
                  />
                }
              />
              <Route
                path="*"
                element={<Today key={`${location.key}:${snapshot.document.userId}`} />}
              />
            </Routes>
          </main>
        </div>
        <nav className="mobile-nav" aria-label={t('navigation')}>
          {nav.map(({ path, key, icon: Icon }) => (
            <NavLink key={key} to={path} end={path === '/'}>
              <Icon size={22} />
              <span>{t(key)}</span>
            </NavLink>
          ))}
        </nav>
        {!preferences!.onboarded && location.pathname !== '/user-id' && (
          <Modal dismissible={false} title={t('onboardingTitle')} onClose={() => {}}>
            <p className="muted">{t('onboardingSubtitle')}</p>
            {error && (
              <p className="form-error" role="alert">
                {t(error)}
              </p>
            )}
            <ProfileForm
              key={snapshot.document.userId}
              onboarding
              onThemePreview={(theme) =>
                setThemePreview({ userId: snapshot.document.userId, theme })
              }
            />
            <NavLink className="text-button" to="/user-id">
              {t('useExistingProfile')}
            </NavLink>
          </Modal>
        )}
        {modal && (
          <Modal
            className={modal.kind === 'avatar' ? 'avatar-modal' : ''}
            dismissible={modal.kind !== 'avatar' || !busy}
            title={
              modal.kind === 'confirm'
                ? modal.title
                : t(
                    modal.kind === 'habit'
                      ? modal.habit
                        ? 'editHabit'
                        : 'newHabit'
                      : modal.kind === 'goal'
                        ? modal.goal
                          ? 'editGoal'
                          : 'newGoal'
                        : modal.kind === 'step'
                          ? modal.step
                            ? 'editStep'
                            : 'newStep'
                          : modal.kind === 'avatar'
                            ? 'editAvatar'
                            : modal.kind === 'gift'
                              ? 'newGift'
                              : 'installTitle',
                  )
            }
            description={
              modal.kind === 'confirm'
                ? modal.message
                : modal.kind === 'avatar'
                  ? t(modal.draft ? 'avatarDraftHint' : 'avatarEditHint')
                  : undefined
            }
            onClose={() => {
              setModal(null);
              setError('');
            }}
          >
            {error && (
              <p className="form-error" role="alert">
                {t(error)}
              </p>
            )}
            {modal.kind === 'avatar' ? (
              <AvatarForm modal={modal} />
            ) : modal.kind === 'confirm' ? (
              <div className="form-actions">
                <button className="button secondary" data-autofocus onClick={() => setModal(null)}>
                  {t('cancel')}
                </button>
                <button
                  className="button primary"
                  disabled={busy}
                  onClick={() => {
                    setModal(null);
                    void modal.onConfirm();
                  }}
                >
                  {modal.confirmLabel}
                </button>
              </div>
            ) : modal.kind === 'install' ? (
              <div className="install-content">
                <Download size={36} />
                <p>{t('installHelp')}</p>
              </div>
            ) : (
              <ChallengeForm modal={modal} />
            )}
          </Modal>
        )}
        {error && !modal && preferences!.onboarded && (
          <Modal
            title={t('alertTitle')}
            role="alertdialog"
            description={t(error)}
            onClose={() => setError('')}
          >
            <div className="form-actions">
              <button className="button primary" data-autofocus onClick={() => setError('')}>
                {t('ok')}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </Context.Provider>
  );
}

function Heading({
  title,
  subtitle,
  children,
  eyebrow,
  className = '',
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
  eyebrow?: string;
  className?: string;
}) {
  return (
    <div className={`page-heading ${className}`}>
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
  );
}
function scheduleLabel(schedule: HabitSchedule, t: TFunction): string {
  const recurrence = schedule.recurrence;
  if (!recurrence)
    return schedule.weekdays.length === 7
      ? t('daily')
      : schedule.weekdays.map((d) => t(`weekday${d}`)).join(' · ');
  if (recurrence.every === 1)
    return t(
      recurrence.unit === 'day' ? 'daily' : recurrence.unit === 'week' ? 'weekly' : 'monthly',
    );
  return t(
    recurrence.unit === 'day'
      ? 'everyDays'
      : recurrence.unit === 'week'
        ? 'everyWeeks'
        : 'everyMonths',
    { count: recurrence.every },
  );
}

function TaskRow({
  type,
  id,
  title,
  subtitle,
  date,
  timezone,
  color = 'sage',
  icon,
  children,
  disabled = false,
}: {
  type: CompletionOperation['targetType'];
  id: string;
  title: string;
  subtitle?: string;
  date: string;
  timezone: string;
  color?: string;
  icon?: IconName;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { snapshot, toggle } = useApp();
  const completed =
    snapshot.document.completions[operationKey(snapshot.document, type, id, date)]?.completed;
  return (
    <div className={`task-row ${completed ? 'checked' : ''}`}>
      <span className={`task-icon ${color}`}>
        <EntityIcon name={icon ?? (type === 'habit' ? 'leaf' : 'target')} size={22} />
      </span>
      <div className="task-copy">
        <strong>{title}</strong>
        <span>{subtitle}</span>
      </div>
      {children}
      <span className="xp-tag">+10 XP</span>
      <button
        className="check-button"
        aria-pressed={!!completed}
        aria-label={t(completed ? 'undoTask' : 'completeTask', { title })}
        disabled={disabled}
        onClick={() => void toggle(type, id, date, timezone)}
      >
        {completed && <Check size={18} strokeWidth={3} />}
      </button>
    </div>
  );
}
function Today() {
  const { t, i18n } = useTranslation();
  const { snapshot } = useApp();
  const { document: doc, progress } = snapshot;
  const today = localDate(doc.preferences.timezone);
  const earliestDate = addDays(today, -(snapshot.dailyHistoryDays ?? 3));
  const [selected, setSelected] = useState('');
  const [showAllOptionalSteps, setShowAllOptionalSteps] = useState(false);
  const date = selected
    ? selected < earliestDate
      ? earliestDate
      : selected > today
        ? today
        : selected
    : today;
  const availableHabits = doc.habits.filter((h) => !h.archivedAt && scheduled(h, date));
  const habits = availableHabits.filter((h) => !isPeriodHabit(scheduleFor(h, date)!));
  const periodHabits = availableHabits.filter((h) => isPeriodHabit(scheduleFor(h, date)!));
  const periodWins = periodHabits.filter((h) => {
    const completion = doc.completions[operationKey(doc, 'habit', h.id, date)];
    return completion?.completed && completion.date === date;
  }).length;
  const steps = doc.goals
    .filter((g) => !g.archivedAt)
    .flatMap((g) =>
      g.steps
        .filter(
          (s) =>
            !s.archivedAt &&
            s.date &&
            s.date <= date &&
            (!doc.completions[completionKey('step', s.id, '')]?.completed ||
              doc.completions[completionKey('step', s.id, '')]?.date === date),
        )
        .map((s) => ({ step: s, goal: g })),
    );
  const optionalStepsByGoal = doc.goals
    .filter((g) => !g.archivedAt)
    .map((goal) => ({
      goal,
      steps: goal.steps.filter((step) => {
        if (step.archivedAt || step.date) return false;
        const completion = doc.completions[completionKey('step', step.id, '')];
        return completion?.completed ? completion.date === date : date === today;
      }),
    }));
  const allOptionalSteps = optionalStepsByGoal.flatMap(({ goal, steps }) =>
    steps.map((step) => ({ step, goal })),
  );
  const optionalSteps = optionalStepsByGoal.flatMap(({ goal, steps }) => {
    const nextStep = steps.find(
      (step) => !doc.completions[completionKey('step', step.id, '')]?.completed,
    );
    return steps
      .filter(
        (step) =>
          showAllOptionalSteps ||
          step === nextStep ||
          doc.completions[completionKey('step', step.id, '')]?.completed,
      )
      .map((step) => ({ step, goal }));
  });
  const optionalCompleted = allOptionalSteps.filter(
    ({ step }) => doc.completions[completionKey('step', step.id, '')]?.completed,
  ).length;
  const hasMoreOptionalSteps = optionalStepsByGoal.some(
    ({ steps }) =>
      steps.filter((step) => !doc.completions[completionKey('step', step.id, '')]?.completed)
        .length > 1,
  );
  const standaloneGoals = doc.goals.filter((goal) => {
    if (goal.archivedAt || goal.steps.some((step) => !step.archivedAt)) return false;
    const completion = doc.completions[completionKey('goal', goal.id, '')];
    return completion?.completed ? completion.date === date : date === today;
  });
  const standaloneCompleted = standaloneGoals.filter(
    (goal) => progress.goals[goal.id]!.done,
  ).length;
  const completedGoals = doc.goals.filter(
    (goal) => !goal.archivedAt && progress.goals[goal.id]!.completedOn === date,
  );
  const total = habits.length + steps.length;
  const completed =
    habits.filter((h) => doc.completions[operationKey(doc, 'habit', h.id, date)]?.completed)
      .length +
    steps.filter(({ step }) => doc.completions[completionKey('step', step.id, '')]?.completed)
      .length;
  const selectedDateLabel = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
  const nextGift = doc.gifts
    .filter((g) => !g.archivedAt && !g.claimedAt)
    .sort(
      (a, b) =>
        progress.gifts[b.id]!.current / progress.gifts[b.id]!.target -
        progress.gifts[a.id]!.current / progress.gifts[a.id]!.target,
    )[0];
  return (
    <>
      <Heading
        title={t('greeting', { name: doc.preferences.name })}
        subtitle={t('todaySubtitle')}
      />
      <section className="daily-hero">
        <div className="hero-copy">
          <span className="small-label">
            <span className="tiny-dot" />
            {t('dailyProgress')}
          </span>
          <h2>
            <span className="hero-headline-reserve" aria-hidden="true">
              {t('keepGoing')}
            </span>
            <span className="hero-headline-reserve" aria-hidden="true">
              {t('allDone')}
            </span>
            <span>{t(completed === total && total ? 'allDone' : 'keepGoing')}</span>
          </h2>
          <p>
            {t('completedOf', { done: completed, total })}
            <span>
              {(completed + periodWins + optionalCompleted + standaloneCompleted) * 10} XP
            </span>
          </p>
          <Bar value={completed} max={total} />
          <div className="hero-micro">{t('littleNote')}</div>
        </div>
        <div className="hero-growth">
          <div className="hero-plant-ring">
            <div
              className="hero-level-progress"
              role="progressbar"
              aria-label={`${t('level', { level: progress.level })} · ${t('progress')}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.levelXp}
              aria-valuetext={`${progress.levelXp} / 100 XP · ${t('xpToNext', { xp: 100 - progress.levelXp })}`}
            >
              <svg viewBox="0 0 240 240" aria-hidden="true">
                <circle className="hero-ring-track" cx="120" cy="120" r="110" />
                <circle
                  className="hero-ring-fill"
                  cx="120"
                  cy="120"
                  r="110"
                  pathLength="100"
                  strokeDasharray="100 100"
                  strokeDashoffset={100 - progress.levelXp}
                  visibility={progress.levelXp ? 'visible' : 'hidden'}
                  transform="rotate(-90 120 120)"
                />
              </svg>
            </div>
            <SproutArt key={doc.userId} level={progress.level} framed />
          </div>
          <div className="hero-level-copy">
            <div className="hero-level-summary">
              <strong>{t('level', { level: progress.level })}</strong>
              <span className="hero-level-dot" aria-hidden="true">
                ·
              </span>
              <span className="hero-total-xp">
                <span className="visually-hidden">{t('totalXp')}: </span>
                {progress.xp} XP
              </span>
            </div>
            <div className="hero-next-level">{t('xpToNext', { xp: 100 - progress.levelXp })}</div>
          </div>
        </div>
      </section>
      <div className="dashboard-grid">
        <div className="challenge-column">
          <div className="history-toolbar">
            <div className="history-date">
              <span>{t('logPastDay')}</span>
              <span className="history-date-field">
                <CalendarDays size={16} aria-hidden="true" />
                <time
                  dateTime={date}
                  aria-label={t('dateHistory')}
                  aria-describedby="history-help"
                  aria-live="polite"
                >
                  {selectedDateLabel}
                </time>
              </span>
            </div>
            <div className="history-actions">
              <button
                className="icon-button"
                aria-label={t('previousDay')}
                disabled={date <= earliestDate}
                onClick={() => setSelected(date > earliestDate ? addDays(date, -1) : earliestDate)}
              >
                <ChevronLeft size={18} />
              </button>
              <button
                className="icon-button"
                aria-label={t('nextDay')}
                disabled={date >= today}
                onClick={() => setSelected(date < today ? addDays(date, 1) : today)}
              >
                <ChevronRight size={18} />
              </button>
            </div>
            <p id="history-help">{t(date < today ? 'pastDayHelp' : 'historyHelp')}</p>
          </div>
          {completedGoals.length > 0 && (
            <section className="completed-goals" aria-labelledby="completed-goals-heading">
              <div className="section-heading">
                <h2 id="completed-goals-heading">
                  <Trophy size={18} aria-hidden="true" />
                  {t('completedGoals')}
                  <span className="count-pill">{completedGoals.length}</span>
                </h2>
              </div>
              {completedGoals.map((goal) => (
                <NavLink className="completed-goal" to="/goals" key={goal.id}>
                  <span className={`task-icon ${goal.color}`}>
                    <EntityIcon name={goal.icon ?? 'target'} />
                  </span>
                  <span className="task-copy">
                    <strong>{goal.title}</strong>
                    <span>{t('goalCompleted')}</span>
                  </span>
                  <ArrowUpRight size={18} aria-hidden="true" />
                </NavLink>
              ))}
            </section>
          )}
          <div className="section-heading">
            <h2>
              {t('dailyHabits')}
              <span className="count-pill">{habits.length}</span>
            </h2>
            <NavLink to="/habits" aria-label={t('habits')} className="text-button">
              <ArrowUpRight size={17} />
            </NavLink>
          </div>
          <div className="panel task-list">
            {habits.length ? (
              habits.map((h) => (
                <TaskRow
                  key={h.id}
                  type="habit"
                  id={h.id}
                  title={h.title}
                  subtitle={h.description || scheduleLabel(scheduleFor(h, date)!, t)}
                  date={date}
                  timezone={scheduleFor(h, date)!.timezone}
                  color={h.color}
                  icon={h.icon}
                />
              ))
            ) : (
              <Empty
                title={t(date < today ? 'noPastHabits' : 'noHabits')}
                description={t(date < today ? 'noPastHabitsDescription' : 'noHabitsDescription')}
              />
            )}
          </div>
          {periodHabits.length > 0 && (
            <section className="period-habits">
              <div className="section-heading">
                <h2>
                  {t('periodHabits')}
                  <span className="count-pill">{periodHabits.length}</span>
                </h2>
              </div>
              <p className="form-hint">{t('periodHabitsHint')}</p>
              <div className="panel task-list">
                {periodHabits.map((h) => {
                  const occurrence = occurrenceFor(h, date)!;
                  const completion = doc.completions[operationKey(doc, 'habit', h.id, date)];
                  return (
                    <TaskRow
                      key={h.id}
                      type="habit"
                      id={h.id}
                      title={h.title}
                      subtitle={[
                        scheduleLabel(occurrence.schedule, t),
                        t('periodEnds', { date: occurrence.end }),
                        t('streak', { count: progress.habits[h.id]!.current }),
                        completion?.completed ? t('completedOn', { date: completion.date }) : '',
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      date={date}
                      timezone={occurrence.timezone}
                      color={h.color}
                      icon={h.icon}
                    />
                  );
                })}
              </div>
            </section>
          )}
          <div className="section-heading steps-heading">
            <h2>
              {t('goalSteps')}
              <span className="count-pill">{steps.length}</span>
            </h2>
            <NavLink to="/goals" aria-label={t('goals')} className="text-button">
              <ArrowUpRight size={17} />
            </NavLink>
          </div>
          <div className="panel task-list">
            {steps.length ? (
              steps.map(({ step, goal }) => (
                <TaskRow
                  key={step.id}
                  type="step"
                  id={step.id}
                  title={step.title}
                  subtitle={`${goal.title} · ${t(step.date! < date ? 'overdue' : 'dueToday')}`}
                  date={date}
                  timezone={doc.preferences.timezone}
                  color={goal.color}
                  icon={step.icon}
                />
              ))
            ) : (
              <div className="quiet-empty">
                <Target size={19} />
                <p>{t('noDueSteps')}</p>
              </div>
            )}
          </div>
          {(optionalSteps.length > 0 || standaloneGoals.length > 0) && (
            <section className="optional-steps" aria-labelledby="optional-steps-heading">
              <div className="section-heading steps-heading">
                <h2 id="optional-steps-heading">
                  {t('optionalSteps')}
                  <span className="count-pill">
                    {allOptionalSteps.length + standaloneGoals.length}
                  </span>
                </h2>
              </div>
              <p className="optional-steps-help">{t('optionalStepsHelp')}</p>
              <div className="panel task-list" id="optional-step-list">
                {standaloneGoals.map((goal) => (
                  <TaskRow
                    key={goal.id}
                    type="goal"
                    id={goal.id}
                    title={goal.title}
                    subtitle={t('standaloneGoal')}
                    date={date}
                    timezone={doc.preferences.timezone}
                    color={goal.color}
                    icon={goal.icon}
                  />
                ))}
                {optionalSteps.map(({ step, goal }) => (
                  <TaskRow
                    key={step.id}
                    type="step"
                    id={step.id}
                    title={step.title}
                    subtitle={goal.title}
                    date={date}
                    timezone={doc.preferences.timezone}
                    color={goal.color}
                    icon={step.icon}
                  />
                ))}
              </div>
              {date === today && hasMoreOptionalSteps && (
                <button
                  className="text-button optional-steps-toggle"
                  aria-expanded={showAllOptionalSteps}
                  aria-controls="optional-step-list"
                  onClick={() => setShowAllOptionalSteps((show) => !show)}
                >
                  {t(showAllOptionalSteps ? 'showFewerSteps' : 'showAllSteps')}
                </button>
              )}
            </section>
          )}
        </div>
        <aside className="dashboard-aside" aria-label={t('progress')}>
          <section className="panel streak-card">
            <h3>
              <Flame size={18} />
              {t('yourStreaks')}
            </h3>
            {doc.habits
              .filter((h) => !h.archivedAt)
              .map((h) => (
                <div key={h.id}>
                  <span>{h.title}</span>
                  <strong>
                    <Flame size={13} />
                    {progress.habits[h.id]!.current}
                  </strong>
                </div>
              ))}
            <p>{t('streakExplanation')}</p>
          </section>
          <section className="panel next-gift-card">
            <span className="gift-illustration">
              <GiftIcon size={31} strokeWidth={1.6} />
              <Sparkles size={13} />
            </span>
            <span className="small-label">{t('nextGift')}</span>
            <h3>{nextGift?.title ?? t('emptyGifts')}</h3>
            {nextGift ? (
              <>
                <p>{giftDescription(nextGift, doc, t)}</p>
                <Bar
                  value={progress.gifts[nextGift.id]!.current}
                  max={progress.gifts[nextGift.id]!.target}
                />
                <div className="gift-fraction">
                  {Math.min(
                    progress.gifts[nextGift.id]!.current,
                    progress.gifts[nextGift.id]!.target,
                  )}{' '}
                  / {progress.gifts[nextGift.id]!.target}
                </div>
              </>
            ) : (
              <p>{t('noNextGift')}</p>
            )}
            <NavLink to="/rewards" className="text-button">
              {t('viewRewards')}
              <ChevronRight size={16} />
            </NavLink>
          </section>
        </aside>
      </div>
    </>
  );
}

function Goals() {
  const { t } = useTranslation();
  const { snapshot, setModal, action, toggle, busy } = useApp();
  const [archived, setArchived] = useState(false);
  const doc = snapshot.document;
  const today = localDate(doc.preferences.timezone);
  const goals = doc.goals.filter((g) =>
    archived ? g.archivedAt || g.steps.some((s) => s.archivedAt) : !g.archivedAt,
  );
  function archive(kind: string, id: string, title: string) {
    setModal({
      kind: 'confirm',
      title: t('archive'),
      message: t('archiveConfirm', { title }),
      confirmLabel: t('archive'),
      onConfirm: () => action(`/api/${kind}/${id}`, 'DELETE'),
    });
  }
  async function move(goal: Goal, index: number, delta: number) {
    const steps = goal.steps.filter((s) => !s.archivedAt);
    const order = goal.steps.map((s) => s.id);
    const from = order.indexOf(steps[index]!.id);
    const to = order.indexOf(steps[index + delta]!.id);
    [order[from], order[to]] = [order[to]!, order[from]!];
    await action(`/api/goals/${goal.id}/order`, 'PUT', order);
  }
  return (
    <>
      <Heading title={t('goals')} subtitle={t('goalsSubtitle')}>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => setModal({ kind: 'goal' })}
        >
          <Plus size={18} />
          {t('addGoal')}
        </button>
      </Heading>
      <div className="list-toolbar">
        <label className="archive-toggle">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          {t('archived')}
        </label>
      </div>
      <div className="goal-grid">
        {goals.length ? (
          goals.map((goal) => {
            const progress = snapshot.progress.goals[goal.id]!;
            const hasSteps = goal.steps.some((step) => !step.archivedAt);
            const visibleSteps = goal.steps.filter((step) =>
              archived ? goal.archivedAt || step.archivedAt : !step.archivedAt,
            );
            return (
              <section className="panel goal-card" key={goal.id}>
                <div className="goal-card-heading">
                  <span className={`task-icon ${goal.color}`}>
                    <EntityIcon name={goal.icon ?? 'target'} />
                  </span>
                  <div>
                    <h2>{goal.title}</h2>
                    {goal.description && <p>{goal.description}</p>}
                    {!hasSteps && progress.done && (
                      <span className="goal-complete-status">
                        <CircleCheck size={14} />
                        {t('complete')}
                      </span>
                    )}
                  </div>
                  {!archived && (
                    <div className="card-actions">
                      <button
                        className="icon-button"
                        aria-label={`${t('edit')} ${goal.title}`}
                        disabled={busy}
                        onClick={() => setModal({ kind: 'goal', goal })}
                      >
                        <Pencil size={16} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`${t('archive')} ${goal.title}`}
                        disabled={busy}
                        onClick={() => void archive('goals', goal.id, goal.title)}
                      >
                        <Archive size={16} />
                      </button>
                    </div>
                  )}
                </div>
                {hasSteps && (
                  <>
                    <div className="goal-progress-label">
                      <span>
                        {t('goalProgress', { done: progress.completed, total: progress.total })}
                      </span>
                      {progress.done && (
                        <span>
                          <CircleCheck size={14} />
                          {t('complete')}
                        </span>
                      )}
                    </div>
                    <Bar value={progress.completed} max={progress.total} />
                  </>
                )}
                {visibleSteps.length > 0 && (
                  <div className="goal-steps">
                    {visibleSteps.map((step, index, steps) => {
                      return (
                        <div key={step.id} className="step-container">
                          <TaskRow
                            type="step"
                            id={step.id}
                            title={step.title}
                            subtitle={[
                              step.date ?? t('undated'),
                              step.archivedAt ? t('archived') : '',
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                            date={today}
                            timezone={doc.preferences.timezone}
                            color={goal.color}
                            icon={step.icon}
                            disabled={
                              !!(goal.archivedAt || step.archivedAt) &&
                              !doc.completions[completionKey('step', step.id, '')]
                            }
                          />
                          {!archived && (
                            <div className="step-tools">
                              <button
                                className="icon-button"
                                aria-label={`${t('moveUp')} ${step.title}`}
                                disabled={index === 0 || busy}
                                onClick={() => void move(goal, index, -1)}
                              >
                                <ArrowUp size={14} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`${t('moveDown')} ${step.title}`}
                                disabled={index === steps.length - 1 || busy}
                                onClick={() => void move(goal, index, 1)}
                              >
                                <ArrowDown size={14} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`${t('edit')} ${step.title}`}
                                disabled={busy}
                                onClick={() => setModal({ kind: 'step', goal, step })}
                              >
                                <Pencil size={14} />
                              </button>
                              <button
                                className="icon-button"
                                aria-label={`${t('archive')} ${step.title}`}
                                disabled={busy}
                                onClick={() => archive('steps', step.id, step.title)}
                              >
                                <Archive size={16} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
                {(!archived || !hasSteps) && (
                  <div
                    className={`goal-card-footer ${!hasSteps && progress.done ? 'checked' : ''}`}
                  >
                    {!archived && (
                      <button
                        className="text-button add-step"
                        disabled={busy}
                        onClick={() => setModal({ kind: 'step', goal })}
                      >
                        <Plus size={16} />
                        {t('addStep')}
                      </button>
                    )}
                    {!hasSteps && (
                      <button
                        className="check-button goal-completion"
                        aria-pressed={progress.done}
                        aria-label={t(progress.done ? 'undoTask' : 'completeTask', {
                          title: goal.title,
                        })}
                        disabled={archived && !doc.completions[completionKey('goal', goal.id, '')]}
                        onClick={() =>
                          void toggle('goal', goal.id, today, doc.preferences.timezone)
                        }
                      >
                        {progress.done && <Check size={18} strokeWidth={3} />}
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })
        ) : (
          <div className="panel full-width">
            <Empty title={t('emptyGoals')} description={t('emptyGoalsDescription')} icon={Target} />
          </div>
        )}
      </div>
    </>
  );
}
function Habits() {
  const { t } = useTranslation();
  const { snapshot, setModal, action, busy } = useApp();
  const [archived, setArchived] = useState(false);
  const doc = snapshot.document;
  const habits = doc.habits.filter((h) => !!h.archivedAt === archived);
  function archive(kind: string, id: string, title: string) {
    setModal({
      kind: 'confirm',
      title: t('archive'),
      message: t('archiveConfirm', { title }),
      confirmLabel: t('archive'),
      onConfirm: () => action(`/api/${kind}/${id}`, 'DELETE'),
    });
  }
  return (
    <>
      <Heading title={t('habits')} subtitle={t('habitsSubtitle')}>
        <button
          className="button primary"
          disabled={busy}
          onClick={() => setModal({ kind: 'habit' })}
        >
          <Plus size={18} />
          {t('addChallenge')}
        </button>
      </Heading>
      <div className="list-toolbar">
        <label className="archive-toggle">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          {t('archived')}
        </label>
      </div>
      <div className="habit-grid">
        {habits.length ? (
          habits.map((h) => (
            <section className="panel habit-card" key={h.id}>
              <div className="goal-card-heading">
                <span className={`task-icon ${h.color}`}>
                  <EntityIcon name={h.icon ?? 'leaf'} />
                </span>
                <div>
                  <h2>{h.title}</h2>
                  <p>{h.description}</p>
                </div>
                {!archived && (
                  <div className="card-actions">
                    <button
                      className="icon-button"
                      aria-label={`${t('edit')} ${h.title}`}
                      disabled={busy}
                      onClick={() => setModal({ kind: 'habit', habit: h })}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`${t('archive')} ${h.title}`}
                      disabled={busy}
                      onClick={() => void archive('habits', h.id, h.title)}
                    >
                      <Archive size={16} />
                    </button>
                  </div>
                )}
              </div>
              {h.schedules.at(-1)!.recurrence ? (
                <p className="habit-interval">{scheduleLabel(h.schedules.at(-1)!, t)}</p>
              ) : (
                <div className="weekday-strip">
                  {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                    <span
                      key={day}
                      className={h.schedules.at(-1)!.weekdays.includes(day) ? 'selected' : ''}
                    >
                      {t(`weekday${day}`)}
                    </span>
                  ))}
                </div>
              )}
              {h.schedules.at(-1)!.from > localDate(doc.preferences.timezone) && (
                <p className="form-hint">
                  {t('scheduleEffective', { date: h.schedules.at(-1)!.from })}
                </p>
              )}
              <div className="habit-stats">
                <span>
                  <Flame size={16} />
                  {t('streak', { count: snapshot.progress.habits[h.id]!.current })}
                </span>
                <span>{t('bestStreak', { count: snapshot.progress.habits[h.id]!.best })}</span>
              </div>
            </section>
          ))
        ) : (
          <div className="panel full-width">
            <Empty title={t('noHabits')} description={t('noHabitsDescription')} />
          </div>
        )}
      </div>
    </>
  );
}
function giftDescription(
  gift: Gift,
  doc: Bootstrap['document'],
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const name =
    (gift.targetType === 'goal' ? doc.goals : doc.habits).find((item) => item.id === gift.targetId)
      ?.title ?? t('missingTarget');
  return t(
    gift.targetType === 'goal'
      ? 'giftGoal'
      : gift.targetType === 'habitCount'
        ? 'giftCount'
        : 'giftStreak',
    { name, count: gift.threshold },
  );
}
function Rewards() {
  const { t } = useTranslation();
  const { snapshot, setModal, action, busy, notify } = useApp();
  const { document: doc, progress } = snapshot;
  const gifts = doc.gifts.filter((g) => !g.archivedAt);
  return (
    <>
      <Heading title={t('rewards')} subtitle={t('rewardsSubtitle')}>
        <button
          className="button primary"
          disabled={busy || ![...doc.goals, ...doc.habits].some((i) => !i.archivedAt)}
          onClick={() => setModal({ kind: 'gift' })}
        >
          <Plus size={18} />
          {t('addGift')}
        </button>
      </Heading>
      <div className="stats-row">
        <div className="panel">
          <Sparkles />
          <strong>{progress.xp}</strong>
          <span>{t('totalXp')}</span>
        </div>
        <div className="panel">
          <CircleCheck />
          <strong>{progress.wins}</strong>
          <span>{t('wins')}</span>
        </div>
        <div className="panel">
          <Trophy />
          <strong>
            {progress.badges.length}
            <small> / 8</small>
          </strong>
          <span>{t('achievements')}</span>
        </div>
      </div>
      <div className="section-heading">
        <h2>{t('nextGift')}</h2>
        <GiftIcon size={20} />
      </div>
      <div className="gift-grid">
        {gifts.length ? (
          gifts.map((gift) => {
            const p = progress.gifts[gift.id]!;
            return (
              <section className={`panel gift-card ${p.state}`} key={gift.id}>
                <div className="gift-card-top">
                  <span className="gift-illustration">
                    <GiftIcon size={29} />
                  </span>
                  <span className={`status-pill ${p.state}`}>
                    {p.state === 'locked' && <Lock size={12} />}
                    {t(p.state)}
                  </span>
                </div>
                <h3>{gift.title}</h3>
                <p>{giftDescription(gift, doc, t)}</p>
                <Bar value={p.current} max={p.target} />
                <div className="gift-fraction">
                  {Math.min(p.current, p.target)} / {p.target}
                </div>
                {p.state === 'available' ? (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() =>
                      setModal({
                        kind: 'confirm',
                        title: t('claimGift'),
                        message: t('claimConfirm', { title: gift.title }),
                        confirmLabel: t('claimGift'),
                        onConfirm: async () => {
                          if (await action(`/api/gifts/${gift.id}/claim`, 'POST', {}))
                            notify(t('giftCelebration'));
                        },
                      })
                    }
                  >
                    <GiftIcon size={16} />
                    {t('claimGift')}
                  </button>
                ) : p.state === 'claimed' ? (
                  <div className="claimed-label">
                    <Check size={16} />
                    {new Intl.DateTimeFormat(doc.preferences.language).format(
                      new Date(gift.claimedAt!),
                    )}
                  </div>
                ) : (
                  <div className="gift encouragement">{t('keepGoing')}</div>
                )}
                <button
                  className="gift-archive icon-button"
                  aria-label={`${t('archive')} ${gift.title}`}
                  disabled={busy}
                  onClick={() =>
                    setModal({
                      kind: 'confirm',
                      title: t('archive'),
                      message: t('archiveConfirm', { title: gift.title }),
                      confirmLabel: t('archive'),
                      onConfirm: () => action(`/api/gifts/${gift.id}`, 'DELETE'),
                    })
                  }
                >
                  <Archive size={14} />
                </button>
              </section>
            );
          })
        ) : (
          <div className="panel full-width">
            <Empty
              title={t('emptyGifts')}
              description={t('emptyGiftsDescription')}
              icon={GiftIcon}
            />
          </div>
        )}
      </div>
      <div className="section-heading achievements-heading">
        <h2>{t('achievements')}</h2>
        <span className="muted">
          {progress.badges.length} / 8 {t('earned')}
        </span>
      </div>
      <div className="badge-grid">
        {badgeDefinitions.map(([id, name, description, count, Icon], index) => {
          const earned = progress.badges.includes(id);
          return (
            <div key={id} className={`panel badge-card ${earned ? 'earned' : ''}`}>
              <div className={`badge-art ${colors[index % colors.length]}`}>
                <Icon size={27} strokeWidth={1.6} />
                {earned && (
                  <span>
                    <Check size={10} />
                  </span>
                )}
              </div>
              <h3>{t(name)}</h3>
              <p>{t(description, { count })}</p>
              <span className="badge-state">{t(earned ? 'earned' : 'locked')}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Settings() {
  const { t, i18n } = useTranslation();
  const { snapshot, install } = useApp();
  return (
    <>
      <Heading title={t('settings')} subtitle={t('settingsSubtitle')} />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <h2>{t('profile')}</h2>
          <ProfileForm key={snapshot.document.userId} />
        </section>
        <div>
          <NotificationsPanel key={snapshot.document.userId} userId={snapshot.document.userId} />
          <section className="panel settings-panel">
            <span className="settings-feature-icon">
              <Download size={24} />
            </span>
            <h2>{t('installTitle')}</h2>
            <p>{t('installHelp')}</p>
            <button className="button secondary" onClick={() => void install()}>
              <Download size={16} />
              {t('install')}
            </button>
          </section>
          <section className="panel settings-panel">
            <span className="settings-feature-icon">
              <RefreshCw size={24} />
            </span>
            <h2>{t('syncLog')}</h2>
            <p>{t('syncLogHelp')}</p>
            <NavLink className="button secondary" to="/settings/sync-log">
              {t('viewSyncLog')}
              <ChevronRight size={16} />
            </NavLink>
          </section>
          <section className="panel settings-panel">
            <span className="settings-feature-icon">
              <Leaf size={24} />
            </span>
            <h2>{t('selfHosted')}</h2>
            <p>{t('browserProfile')}</p>
            <dl className="build-info">
              <div>
                <dt>{t('version')}</dt>
                <dd>{buildInfo.version}</dd>
              </div>
              <div>
                <dt>{t('buildDate')}</dt>
                <dd>
                  <time dateTime={buildInfo.builtAt}>
                    {new Intl.DateTimeFormat(i18n.language, {
                      dateStyle: 'medium',
                      timeStyle: 'long',
                      timeZone: snapshot.document.preferences.timezone,
                    }).format(new Date(buildInfo.builtAt))}
                  </time>
                </dd>
              </div>
            </dl>
            <a
              className="text-button credits-link"
              href="/credits.txt"
              target="_blank"
              rel="noreferrer"
            >
              {t('sourceCode')}
              <ArrowUpRight size={14} />
            </a>
          </section>
        </div>
      </div>
    </>
  );
}
function SyncLog() {
  const { t, i18n } = useTranslation();
  const { snapshot, entry, online, syncing, sync } = useApp();
  const userId = snapshot.document.userId;
  const queryClient = useQueryClient();
  const queryKey = ['sync-log', userId];
  const log = useQuery({ queryKey, queryFn: () => loadSyncLog(userId), networkMode: 'always' });
  useEffect(
    () =>
      subscribeSyncLog(userId, () => {
        void queryClient.invalidateQueries({ queryKey: ['sync-log', userId] });
      }),
    [queryClient, userId],
  );
  return (
    <>
      <NavLink className="text-button" to="/settings">
        <ChevronLeft size={16} />
        {t('settings')}
      </NavLink>
      <Heading title={t('syncLog')} subtitle={t('syncLogHelp')} className="sync-log-page-heading">
        <button
          className="button secondary"
          disabled={!online || syncing}
          onClick={() => void sync()}
        >
          <RefreshCw size={16} className={syncing ? 'spin' : ''} />
          {t('syncNow')}
        </button>
      </Heading>
      <p className="muted sync-log-summary" role="status">
        {t(
          !online
            ? 'offline'
            : syncing
              ? 'syncing'
              : entry.queue.length
                ? 'queued'
                : 'syncUpToDate',
          { count: entry.queue.length },
        )}
      </p>
      {log.isPending ? (
        <p className="muted">{t('loading')}</p>
      ) : log.isError ? (
        <div className="panel settings-panel">
          <p>{t(log.error instanceof ApiError ? log.error.code : 'INTERNAL_ERROR')}</p>
          <button className="button secondary" onClick={() => void log.refetch()}>
            {t('retry')}
          </button>
        </div>
      ) : log.data?.length ? (
        <ol className="sync-log-list">
          {log.data.map((operation) => (
            <li className="panel sync-log-operation" key={operation.id}>
              <div className="sync-log-heading">
                <strong>
                  {t(
                    operation.status === 'success'
                      ? 'syncSucceeded'
                      : operation.status === 'blocked'
                        ? 'syncBlocked'
                        : 'syncFailed',
                  )}
                </strong>
                <time dateTime={operation.startedAt}>
                  {new Date(operation.startedAt).toLocaleString(i18n.language)}
                </time>
              </div>
              <p>
                {t('syncDetails', {
                  count: operation.changes,
                  duration: (operation.durationMs / 1000).toLocaleString(i18n.language, {
                    maximumFractionDigits: 2,
                  }),
                  attempts: operation.attempts,
                })}
              </p>
              {operation.status === 'success' && (
                <p>
                  {t(operation.uploaded ? 'syncUploaded' : 'syncChecked', {
                    revision: operation.revision,
                  })}
                </p>
              )}
              {operation.error && <p className="sync-log-error">{t(operation.error)}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <Empty icon={RefreshCw} title={t('syncLogEmpty')} />
      )}
    </>
  );
}

function ProfileForm({
  onboarding = false,
  onThemePreview,
}: {
  onboarding?: boolean;
  onThemePreview?: (theme: Preferences['theme']) => void;
}) {
  const { t, i18n } = useTranslation();
  const { snapshot, action, busy, setModal } = useApp();
  const formBaseline = useRef(snapshot.document.preferences);
  const pendingNameSave = useRef<{ timer: number; save: () => void } | null>(null);
  function flushNameSave() {
    const pending = pendingNameSave.current;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingNameSave.current = null;
    pending.save();
  }
  // Keep the last edit when navigating away before the delay expires.
  useEffect(() => () => flushNameSave(), []);
  const [value, setValue] = useState<Preferences>(() => ({
    ...snapshot.document.preferences,
    ...(onboarding
      ? {
          name:
            snapshot.document.preferences.name === 'Friend'
              ? ''
              : snapshot.document.preferences.name,
          language: i18n.language.startsWith('de') ? 'de' : 'en',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }
      : {}),
  }));
  useEffect(() => {
    const preferences = snapshot.document.preferences;
    const baseline = formBaseline.current;
    setValue((current) => {
      const updated = { ...current };
      for (const key of Object.keys(preferences) as Array<keyof Preferences>) {
        if (same(current[key], baseline[key])) Object.assign(updated, { [key]: preferences[key] });
      }
      return updated;
    });
    formBaseline.current = preferences;
  }, [snapshot.document.preferences]);
  const zones = Array.from(new Set([value.timezone, 'UTC', ...Intl.supportedValuesOf('timeZone')]));
  function update(patch: Partial<Preferences>) {
    setValue((current) => ({ ...current, ...patch }));
    if (!onboarding) void action('/api/preferences', 'PATCH', patch);
  }
  function updateName(name: string) {
    setValue((current) => ({ ...current, name }));
    if (pendingNameSave.current) {
      window.clearTimeout(pendingNameSave.current.timer);
      pendingNameSave.current = null;
    }
    const savedName = name.trim();
    // An empty name is a temporary editing state, not a valid preference.
    if (onboarding || !savedName || savedName === formBaseline.current.name) return;
    pendingNameSave.current = {
      timer: window.setTimeout(flushNameSave, 500),
      save: () => {
        if (savedName !== formBaseline.current.name)
          void action('/api/preferences', 'PATCH', { name: savedName });
      },
    };
  }
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!onboarding) return;
    const updated = { ...value, onboarded: true };
    const patch = Object.fromEntries(
      Object.entries(updated).filter(
        ([key, v]) =>
          JSON.stringify(v) !== JSON.stringify(formBaseline.current[key as keyof Preferences]),
      ),
    );
    if (await action('/api/preferences', 'PATCH', patch)) {
      formBaseline.current = updated;
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="profile-form">
      <div className="avatar-editor">
        <Avatar seed={value.avatarSeed} options={value.avatarOptions} size={80} />
        <button
          type="button"
          className="button secondary"
          disabled={onboarding && busy}
          onClick={() =>
            setModal({
              kind: 'avatar',
              initial: value,
              draft: onboarding,
              onApply: (avatar) => {
                setValue((current) => ({ ...current, ...avatar }));
              },
            })
          }
        >
          <Pencil size={15} />
          {t('editAvatar')}
        </button>
      </div>
      <label>
        {t('name')}
        <input
          required
          maxLength={60}
          value={value.name}
          onChange={(e) => updateName(e.target.value)}
          onBlur={() => {
            if (!onboarding) {
              flushNameSave();
              setValue((current) => ({
                ...current,
                name: current.name.trim() || snapshot.document.preferences.name,
              }));
            }
          }}
          {...noAutofill}
        />
      </label>
      <div className="form-two">
        <label>
          {t('language')}
          <select
            aria-label={t('language')}
            value={value.language}
            onChange={(e) => {
              const language = e.target.value as 'en' | 'de';
              update({ language });
              if (onboarding) void i18n.changeLanguage(language);
            }}
          >
            <option value="en">English</option>
            <option value="de">Deutsch</option>
          </select>
        </label>
        <label>
          {t('timezone')}
          <select
            aria-label={t('timezone')}
            value={value.timezone}
            onChange={(e) => update({ timezone: e.target.value })}
          >
            {zones.map((zone) => (
              <option key={zone}>{zone}</option>
            ))}
          </select>
        </label>
      </div>
      <p className="form-hint">{t('timezoneHint')}</p>
      <fieldset>
        <legend>{t('appearance')}</legend>
        <div className="theme-options">
          {(['light', 'dark', 'system'] as const).map((theme, index) => {
            const Icon = [Sun, Moon, SettingsIcon][index]!;
            return (
              <button
                type="button"
                key={theme}
                className={value.theme === theme ? 'selected' : ''}
                aria-pressed={value.theme === theme}
                onClick={() => {
                  update({ theme });
                  onThemePreview?.(theme);
                }}
              >
                <Icon size={18} />
                {t(theme)}
              </button>
            );
          })}
        </div>
      </fieldset>
      {onboarding && (
        <button className="button primary" disabled={busy} type="submit">
          {t('letsGo')}
          <ArrowUpRight size={16} />
        </button>
      )}
    </form>
  );
}

function AvatarForm({ modal }: { modal: Extract<ModalState, { kind: 'avatar' }> }) {
  const { t } = useTranslation();
  const { action, busy, setModal, notify } = useApp();
  return (
    <AvatarEditor
      initial={modal.initial}
      busy={busy}
      canSave={true}
      draft={modal.draft}
      onCancel={() => setModal(null)}
      onSave={async (avatar) => {
        const { avatarSeed, avatarOptions } = avatar;
        if (
          modal.draft ||
          (await action('/api/preferences', 'PATCH', { avatarSeed, avatarOptions }))
        ) {
          modal.onApply?.(avatar);
          setModal(null);
          if (!modal.draft) notify(t('avatarSaved'));
        }
      }}
    />
  );
}

function ChallengeForm({
  modal,
}: {
  modal: Exclude<ModalState, null | { kind: 'install' | 'confirm' | 'avatar' }>;
}) {
  const { t } = useTranslation();
  const { snapshot, action, busy, setModal } = useApp();
  const initial =
    modal.kind === 'habit'
      ? modal.habit
      : modal.kind === 'goal'
        ? modal.goal
        : modal.kind === 'step'
          ? modal.step
          : undefined;
  const [title, setTitle] = useState(initial?.title ?? ''),
    [description, setDescription] = useState(
      initial && 'description' in initial ? initial.description : '',
    );
  const [color, setColor] = useState<(typeof colors)[number]>(
    initial && 'color' in initial ? initial.color : modal.kind === 'goal' ? 'lavender' : 'sage',
  );
  const [icon, setIcon] = useState<IconName>(
    initial?.icon ?? (modal.kind === 'habit' ? 'leaf' : 'target'),
  );
  const [weekdays, setWeekdays] = useState(
    modal.kind === 'habit' && modal.habit
      ? modal.habit.schedules.at(-1)!.weekdays
      : [0, 1, 2, 3, 4, 5, 6],
  );
  const latestSchedule = modal.kind === 'habit' ? modal.habit?.schedules.at(-1) : undefined;
  const [reminderEnabled, setReminderEnabled] = useState(
    modal.kind === 'habit' && !!modal.habit?.reminderTime,
  );
  const [reminderTime, setReminderTime] = useState(
    modal.kind === 'habit' ? (modal.habit?.reminderTime ?? '09:00') : '09:00',
  );
  const initialRecurrence = latestSchedule?.recurrence;
  const initialRepeat = initialRecurrence
    ? initialRecurrence.every === 1
      ? initialRecurrence.unit === 'day'
        ? 'custom'
        : initialRecurrence.unit === 'week'
          ? 'weekly'
          : 'monthly'
      : 'custom'
    : (latestSchedule?.weekdays.length ?? 7) === 7
      ? 'daily'
      : 'weekdays';
  const [repeat, setRepeat] = useState(initialRepeat);
  const [every, setEvery] = useState(initialRecurrence?.every ?? 2);
  const [unit, setUnit] = useState<Recurrence['unit']>(initialRecurrence?.unit ?? 'day');
  const editBoundary =
    modal.kind === 'habit' && modal.habit
      ? scheduleChangeDate(modal.habit)
      : localDate(snapshot.document.preferences.timezone);
  const [startDate, setStartDate] = useState(
    latestSchedule && latestSchedule.from >= editBoundary ? latestSchedule.from : editBoundary,
  );
  const [date, setDate] = useState(modal.kind === 'step' ? (modal.step?.date ?? '') : '');
  const [targetType, setTargetType] = useState<'goal' | 'habitCount' | 'habitStreak'>(
    snapshot.document.goals.some((g) => !g.archivedAt) ? 'goal' : 'habitCount',
  );
  const [targetId, setTargetId] = useState(''),
    [threshold, setThreshold] = useState(7),
    [localError, setLocalError] = useState('');
  const sources = (
    targetType === 'goal' ? snapshot.document.goals : snapshot.document.habits
  ).filter((item) => !item.archivedAt);
  const selectedTarget = targetId || sources[0]?.id || '';
  async function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError('');
    let path: string,
      body: unknown,
      method = 'POST';
    if (modal.kind === 'habit') {
      if (
        (repeat === 'weekdays' && !weekdays.length) ||
        (repeat === 'custom' &&
          (!Number.isInteger(every) || every < 1 || every > 365 || !startDate))
      ) {
        setLocalError('VALIDATION_ERROR');
        return;
      }
      path = `/api/habits${modal.habit ? `/${modal.habit.id}` : ''}`;
      method = modal.habit ? 'PATCH' : 'POST';
      const nextUnit: Recurrence['unit'] =
        repeat === 'weekly' ? 'week' : repeat === 'monthly' ? 'month' : unit;
      const nextEvery = repeat === 'custom' ? every : 1;
      const chosenStart = repeat === 'custom' ? startDate : editBoundary;
      const preserveAnchor =
        initialRecurrence?.unit === nextUnit &&
        initialRecurrence.every === nextEvery &&
        (repeat !== 'custom' ||
          startDate ===
            (latestSchedule && latestSchedule.from >= editBoundary
              ? latestSchedule.from
              : editBoundary));
      body = {
        title,
        reminderTime: reminderEnabled ? reminderTime : null,
        description,
        color,
        icon,
        weekdays: repeat === 'weekdays' ? weekdays : [0, 1, 2, 3, 4, 5, 6],
        recurrence:
          repeat === 'daily' || repeat === 'weekdays'
            ? null
            : {
                unit: nextUnit,
                every: nextEvery,
                anchor: preserveAnchor
                  ? initialRecurrence.anchor
                  : alignAnchor(chosenStart, nextUnit),
              },
        ...(repeat === 'custom' && (!modal.habit || startDate !== editBoundary)
          ? { startDate }
          : {}),
      };
    } else if (modal.kind === 'goal') {
      path = `/api/goals${modal.goal ? `/${modal.goal.id}` : ''}`;
      method = modal.goal ? 'PATCH' : 'POST';
      body = { title, description, color, icon };
    } else if (modal.kind === 'step') {
      path = modal.step ? `/api/steps/${modal.step.id}` : `/api/goals/${modal.goal.id}/steps`;
      method = modal.step ? 'PATCH' : 'POST';
      body = { title, date: date || null, icon };
    } else {
      path = '/api/gifts';
      body = {
        title,
        targetType,
        targetId: selectedTarget,
        threshold: targetType === 'goal' ? 1 : threshold,
      };
    }
    if (method === 'PATCH' && initial) {
      const baseline = {
        ...initial,
        ...(modal.kind === 'habit' && modal.habit
          ? {
              weekdays: modal.habit.schedules.at(-1)!.weekdays,
              recurrence: modal.habit.schedules.at(-1)!.recurrence ?? null,
              startDate: modal.habit.schedules.at(-1)!.from,
            }
          : {}),
      };
      body = Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter(
          ([key, value]) =>
            JSON.stringify(value) !== JSON.stringify((baseline as Record<string, unknown>)[key]),
        ),
      );
    }
    if (await action(path, method, body)) setModal(null);
  }
  return (
    <form className="challenge-form" onSubmit={(e) => void submit(e)}>
      <label>
        {t('title')}
        <input
          required
          autoFocus
          maxLength={160}
          {...noAutofill}
          value={title}
          placeholder={t(
            modal.kind === 'habit'
              ? 'habitTitle'
              : modal.kind === 'goal'
                ? 'goalTitle'
                : modal.kind === 'step'
                  ? 'stepTitle'
                  : 'giftTitle',
          )}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      {(modal.kind === 'habit' || modal.kind === 'goal') && (
        <>
          <label>
            {t('description')}
            <textarea
              maxLength={500}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset>
            <legend>{t('color')}</legend>
            <div className="color-options">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`${c} ${color === c ? 'selected' : ''}`}
                  aria-label={t(c)}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                >
                  {color === c && <Check size={18} />}
                </button>
              ))}
            </div>
          </fieldset>
        </>
      )}
      {modal.kind !== 'gift' && (
        <IconPicker
          value={icon}
          color={modal.kind === 'step' ? modal.goal.color : color}
          onChange={setIcon}
        />
      )}
      {modal.kind === 'habit' && (
        <>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={reminderEnabled}
              onChange={(e) => setReminderEnabled(e.target.checked)}
            />
            {t('habitReminder')}
          </label>
          {reminderEnabled && (
            <label>
              {t('reminderTime')}
              <input
                type="time"
                aria-label={t('reminderTime')}
                required
                value={reminderTime}
                onChange={(e) => setReminderTime(e.target.value)}
              />
              <span className="form-hint">
                {t('reminderTimeHint', {
                  timezone: latestSchedule?.timezone ?? snapshot.document.preferences.timezone,
                })}
              </span>
              <span className="form-hint">{t('reminderDeviceHint')}</span>
            </label>
          )}
          <label>
            {t('repeatInterval')}
            <select
              aria-label={t('repeatInterval')}
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            >
              <option value="daily">{t('daily')}</option>
              <option value="weekdays">{t('selectedWeekdays')}</option>
              <option value="weekly">{t('weekly')}</option>
              <option value="monthly">{t('monthly')}</option>
              <option value="custom">{t('customInterval')}</option>
            </select>
          </label>
          {repeat === 'custom' && (
            <div className="interval-fields">
              <label>
                {t('repeatEvery')}
                <input
                  type="number"
                  required
                  min={1}
                  max={365}
                  step={1}
                  value={every}
                  onChange={(e) => setEvery(Number(e.target.value))}
                />
              </label>
              <label>
                {t('intervalUnit')}
                <select
                  aria-label={t('intervalUnit')}
                  value={unit}
                  onChange={(e) => setUnit(e.target.value as Recurrence['unit'])}
                >
                  <option value="day">{t('intervalDays')}</option>
                  <option value="week">{t('intervalWeeks')}</option>
                  <option value="month">{t('intervalMonths')}</option>
                </select>
              </label>
              <label>
                {t('intervalStart')}
                <input
                  type="date"
                  required
                  min={editBoundary}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </label>
              <p className="form-hint">{t('intervalAnchorHint')}</p>
            </div>
          )}
          {repeat === 'weekdays' && (
            <fieldset>
              <legend>{t('repeatOn')}</legend>
              <div className="weekday-buttons">
                {[1, 2, 3, 4, 5, 6, 0].map((day) => (
                  <button
                    type="button"
                    key={day}
                    className={weekdays.includes(day) ? 'selected' : ''}
                    aria-pressed={weekdays.includes(day)}
                    onClick={() =>
                      setWeekdays(
                        weekdays.includes(day)
                          ? weekdays.filter((d) => d !== day)
                          : [...weekdays, day],
                      )
                    }
                  >
                    {t(`weekday${day}`)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          {modal.habit && (
            <p className="form-hint">
              {t('scheduleEffective', { date: repeat === 'custom' ? startDate : editBoundary })}{' '}
              {t('intervalChangeHint')}
            </p>
          )}
        </>
      )}
      {modal.kind === 'step' && (
        <label>
          {t('dateOptional')}
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
      {modal.kind === 'gift' && (
        <>
          <label>
            {t('giftUnlock')}
            <select
              aria-label={t('giftUnlock')}
              value={targetType}
              onChange={(e) => {
                setTargetType(e.target.value as typeof targetType);
                setTargetId('');
              }}
            >
              <option value="goal">{t('goalTarget')}</option>
              <option value="habitCount">{t('countTarget')}</option>
              <option value="habitStreak">{t('streakTarget')}</option>
            </select>
          </label>
          <label>
            {t(targetType === 'goal' ? 'chooseGoal' : 'chooseHabit')}
            <select
              aria-label={t(targetType === 'goal' ? 'chooseGoal' : 'chooseHabit')}
              required
              value={selectedTarget}
              onChange={(e) => setTargetId(e.target.value)}
            >
              <option value="" disabled>
                —
              </option>
              {sources.map((source) => (
                <option value={source.id} key={source.id}>
                  {source.title}
                </option>
              ))}
            </select>
          </label>
          {targetType !== 'goal' && (
            <label>
              {t('target')}
              <input
                required
                type="number"
                min={1}
                max={10000}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </label>
          )}
        </>
      )}
      {localError && (
        <p className="form-error" role="alert">
          {t(localError)}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="button secondary" onClick={() => setModal(null)}>
          {t('cancel')}
        </button>
        <button type="submit" className="button primary" disabled={busy}>
          {t(initial ? 'save' : 'create')}
          <Check size={16} />
        </button>
      </div>
    </form>
  );
}
