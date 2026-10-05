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
import { useRegisterSW } from 'virtual:pwa-register/react';
import { SproutArt } from './Plant';
import { UserIdentity } from './UserIdentity';
import { localUserIdKey } from './identity';
import { lockPageScroll } from './scrollLock';
import { Avatar } from './Avatar';
import { AvatarEditor, type AvatarValue } from './AvatarEditor';
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
  WifiOff,
  X,
  Pencil,
  Archive,
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
  localDate,
  scheduled,
  scheduleFor,
  same,
  type Bootstrap,
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
  syncEntry,
  subscribeEntries,
  mutate,
  switchLocalUser,
  toggleCompletion,
  visibleSnapshot,
  type Entry,
} from './offline';

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
  action: (path: string, method: string, body?: unknown) => Promise<boolean>;
  errorCode: string;
  toggle: (type: 'habit' | 'step', id: string, date: string, timezone: string) => Promise<void>;
  setModal: (state: ModalState) => void;
  notify: (message: string) => void;
  install: () => Promise<void>;
  changeUser: (userId: string) => Promise<void>;
};
const Context = createContext<AppContext | null>(null);
function useApp() {
  return useContext(Context)!;
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
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  return (
    <div
      className="profile-menu"
      ref={ref}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
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
        onClick={() => setOpen(!open)}
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
  const syncRequestedRef = useRef(false);
  const retryDelayRef = useRef(5_000);
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW();
  const entry = query.data;
  const snapshot = entry ? visibleSnapshot(entry) : undefined;
  const preferences = snapshot?.document.preferences;
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
    if (syncingRef.current) {
      syncRequestedRef.current = true;
      return;
    }
    syncRequestedRef.current = false;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const next = await syncEntry();
      retryDelayRef.current = 5_000;
      if (next.snapshot.document.userId === localStorage.getItem(localUserIdKey))
        queryClient.setQueryData(['machbar'], next);
    } catch (e) {
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, 60_000);
      if (!(e instanceof ApiError && (e.code === 'OFFLINE' || e.code === 'ACCOUNT_CHANGED')))
        setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      if (syncRequestedRef.current) void sync();
    }
  };
  useEffect(() => {
    const reconnect = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void sync();
    };
    const foreground = () => {
      if (!document.hidden) void sync();
    };
    const readLocal = async () => {
      const next = await loadEntry();
      if (next.snapshot.document.userId === localStorage.getItem(localUserIdKey))
        queryClient.setQueryData(['machbar'], next);
    };
    const identityChanged = (event: StorageEvent) => {
      if (event.key === localUserIdKey)
        void readLocal().then(() => {
          if (navigator.onLine) void sync();
        });
    };
    const unsubscribe = subscribeEntries(() => {
      void readLocal();
    });
    if (entry && navigator.onLine) void sync();
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', reconnect);
    document.addEventListener('visibilitychange', foreground);
    window.addEventListener('storage', identityChanged);
    // Network status events can be missed after an offline reload. Retry pending
    // changes promptly while keeping the normal refresh interval for idle users.
    let timer: number;
    let cancelled = false;
    const retry = () => {
      if (cancelled) return;
      timer = window.setTimeout(
        () => {
          if (!document.hidden && navigator.onLine) void sync().finally(retry);
          else retry();
        },
        entry?.queue.length ? retryDelayRef.current : 60_000,
      );
    };
    retry();
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
      window.removeEventListener('storage', identityChanged);
      cancelled = true;
      window.clearTimeout(timer);
      window.clearInterval(clock);
      unsubscribe();
    };
  }, [entry?.snapshot.document.userId, entry?.queue.length]);
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
      if (e instanceof ApiError && e.status === 409) await sync();
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function toggle(type: 'habit' | 'step', id: string, date: string, timezone: string) {
    if (!snapshot) return;
    const completed = snapshot.document.completions[completionKey(type, id, date)]?.completed;
    try {
      const next = await toggleCompletion(type, id, date, timezone, snapshot.document.userId);
      queryClient.setQueryData(['machbar'], next);
      if (!completed) setToast(t('celebration'));
      if (navigator.onLine) void sync();
    } catch (e) {
      setError(e instanceof ApiError ? e.code : 'INTERNAL_ERROR');
    }
  }
  async function changeUser(userId: string) {
    if (busy || !snapshot) return;
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
        <aside className="sidebar">
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
            <span className="topbar-quote">
              <Leaf size={15} />
              {t('welcome')}
            </span>
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
            {notifications}
            {(!online || entry.queue.length > 0 || entry.conflict) && (
              <div className="notice" role="status">
                <div>
                  {!online ? (
                    <WifiOff size={18} />
                  ) : (
                    <RefreshCw size={18} className={syncing ? 'spin' : ''} />
                  )}
                  <span>
                    {entry.conflict
                      ? t('conflict')
                      : !online
                        ? t('offline')
                        : t(syncing ? 'syncing' : 'queued', { count: entry.queue.length })}
                  </span>
                </div>
                {entry.conflict ? (
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
                ) : (
                  online && (
                    <button onClick={() => void sync()} disabled={syncing}>
                      {t('syncNow')}
                    </button>
                  )
                )}
              </div>
            )}
            {needRefresh && (
              <div className="notice">
                <span>{t(entry.queue.length ? 'updatePending' : 'updateReady')}</span>
                <button
                  disabled={entry.queue.length > 0}
                  onClick={() => void updateServiceWorker(true)}
                >
                  {t('update')}
                </button>
              </div>
            )}
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
            <footer className="page-footer">
              <span>machbar.</span>
              <span>{t('tagline')}</span>
              <Heart size={13} />
            </footer>
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
}: {
  title: string;
  subtitle: string;
  children?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {children}
    </div>
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
  icon: Icon = Leaf,
  children,
  disabled = false,
}: {
  type: 'habit' | 'step';
  id: string;
  title: string;
  subtitle?: string;
  date: string;
  timezone: string;
  color?: string;
  icon?: LucideIcon;
  children?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const { snapshot, entry, toggle } = useApp();
  const completed = snapshot.document.completions[completionKey(type, id, date)]?.completed;
  const pending = entry.queue.some(
    (op) =>
      op.targetType &&
      op.targetId &&
      op.date &&
      completionKey(op.targetType, op.targetId, op.date) === completionKey(type, id, date),
  );
  return (
    <div className={`task-row ${completed ? 'checked' : ''}`}>
      <span className={`task-icon ${color}`}>
        <Icon size={22} />
      </span>
      <div className="task-copy">
        <strong>{title}</strong>
        <span>
          {subtitle}
          {pending && <em>{t('pending')}</em>}
        </span>
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
  const { snapshot, setModal } = useApp();
  const { document: doc, progress } = snapshot;
  const today = localDate(doc.preferences.timezone);
  const earliestDate = addDays(today, -(snapshot.dailyHistoryDays ?? 3));
  const [selected, setSelected] = useState('');
  const date = selected
    ? selected < earliestDate
      ? earliestDate
      : selected > today
        ? today
        : selected
    : today;
  const habits = doc.habits.filter(
    (h) =>
      (!h.archivedAt ||
        date <=
          localDate(
            scheduleFor(h, date)?.timezone ?? doc.preferences.timezone,
            new Date(h.archivedAt),
          )) &&
      scheduled(h, date),
  );
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
  const total = habits.length + steps.length;
  const completed =
    habits.filter((h) => doc.completions[completionKey('habit', h.id, date)]?.completed).length +
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
          <h2>{t(completed === total && total ? 'allDone' : 'keepGoing')}</h2>
          <p>
            {t('completedOf', { done: completed, total })}
            <span>{completed * 10} XP</span>
          </p>
          <Bar value={completed} max={total} />
          <div className="hero-micro">{t('littleNote')}</div>
        </div>
        <SproutArt key={doc.userId} level={progress.level} />
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
          <div className="section-heading">
            <h2>
              {t('dailyHabits')}
              <span className="count-pill">{habits.length}</span>
            </h2>
          </div>
          <div className="panel task-list">
            {habits.length ? (
              habits.map((h) => (
                <TaskRow
                  key={h.id}
                  type="habit"
                  id={h.id}
                  title={h.title}
                  subtitle={
                    h.description ||
                    (scheduleFor(h, date)!.weekdays.length === 7
                      ? t('daily')
                      : scheduleFor(h, date)!
                          .weekdays.map((d) => t(`weekday${d}`))
                          .join(' · '))
                  }
                  date={date}
                  timezone={scheduleFor(h, date)!.timezone}
                  color={h.color}
                  disabled={!!h.archivedAt && !doc.completions[completionKey('habit', h.id, date)]}
                />
              ))
            ) : (
              <Empty
                title={t(date < today ? 'noPastHabits' : 'noHabits')}
                description={t(date < today ? 'noPastHabitsDescription' : 'noHabitsDescription')}
              >
                <button
                  className="text-button"
                  disabled={false}
                  onClick={() => setModal({ kind: 'habit' })}
                >
                  <Plus size={16} />
                  {t('addChallenge')}
                </button>
              </Empty>
            )}
          </div>
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
                  icon={Target}
                />
              ))
            ) : (
              <div className="quiet-empty">
                <Target size={19} />
                <p>{t('noDueSteps')}</p>
              </div>
            )}
          </div>
        </div>
        <aside className="dashboard-aside">
          <section className="panel level-card">
            <div className="level-top">
              <span className="level-icon">
                <Sparkles size={23} />
              </span>
              <div>
                <span className="small-label">{t('keepGoing')}</span>
                <h3>{t('level', { level: progress.level })}</h3>
              </div>
              <span className="xp-total">
                {progress.xp}
                <small>XP</small>
              </span>
            </div>
            <Bar value={progress.levelXp} className="lavender-bar" />
            <p>{t('xpToNext', { xp: 100 - progress.levelXp })}</p>
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
          <section className="streak-card">
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
        </aside>
      </div>
    </>
  );
}

function Goals() {
  const { t } = useTranslation();
  const { snapshot, setModal, action, busy } = useApp();
  const [archived, setArchived] = useState(false);
  const doc = snapshot.document;
  const today = localDate(doc.preferences.timezone);
  const goals = doc.goals.filter((g) => !!g.archivedAt === archived);
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
    const order = goal.steps.map((s) => s.id);
    [order[index], order[index + delta]] = [order[index + delta]!, order[index]!];
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
            return (
              <section className="panel goal-card" key={goal.id}>
                <div className="goal-card-heading">
                  <span className={`task-icon ${goal.color}`}>
                    <Target size={23} />
                  </span>
                  <div>
                    <h2>{goal.title}</h2>
                    <p>{goal.description}</p>
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
                <div className="goal-steps">
                  {goal.steps
                    .filter((s) => !s.archivedAt)
                    .map((step) => {
                      const index = goal.steps.findIndex((s) => s.id === step.id);
                      return (
                        <div key={step.id} className="step-container">
                          <TaskRow
                            type="step"
                            id={step.id}
                            title={step.title}
                            subtitle={step.date ?? t('undated')}
                            date={today}
                            timezone={doc.preferences.timezone}
                            color={goal.color}
                            icon={Target}
                            disabled={
                              archived && !doc.completions[completionKey('step', step.id, '')]
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
                                disabled={index === goal.steps.length - 1 || busy}
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
                                onClick={() => void archive('steps', step.id, step.title)}
                              >
                                <Archive size={14} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  {!progress.total && <p className="quiet-empty">{t('noSteps')}</p>}
                </div>
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
                  <Leaf size={23} />
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
  const { t } = useTranslation();
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
              <Leaf size={24} />
            </span>
            <h2>{t('selfHosted')}</h2>
            <p>{t('browserProfile')}</p>
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
function ProfileForm({
  onboarding = false,
  onThemePreview,
}: {
  onboarding?: boolean;
  onThemePreview?: (theme: Preferences['theme']) => void;
}) {
  const { t, i18n } = useTranslation();
  const { snapshot, action, busy, notify, setModal } = useApp();
  const formBaseline = useRef(snapshot.document.preferences);
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
  async function submit(e: FormEvent) {
    e.preventDefault();
    const updated = { ...value, onboarded: true };
    const patch = Object.fromEntries(
      Object.entries(updated).filter(
        ([key, v]) =>
          JSON.stringify(v) !== JSON.stringify(formBaseline.current[key as keyof Preferences]),
      ),
    );
    if (await action('/api/preferences', 'PATCH', patch)) {
      formBaseline.current = updated;
      if (!onboarding) notify(t('preferencesSaved'));
    }
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="profile-form">
      <div className="avatar-editor">
        <Avatar seed={value.avatarSeed} options={value.avatarOptions} size={80} />
        <button
          type="button"
          className="button secondary"
          disabled={busy}
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
          onChange={(e) => setValue({ ...value, name: e.target.value })}
          autoComplete="given-name"
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
              setValue({ ...value, language });
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
            onChange={(e) => setValue({ ...value, timezone: e.target.value })}
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
                  setValue({ ...value, theme });
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
      <button className="button primary" disabled={busy} type="submit">
        {t(onboarding ? 'letsGo' : 'save')}
        <ArrowUpRight size={16} />
      </button>
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
  const [weekdays, setWeekdays] = useState(
    modal.kind === 'habit' && modal.habit
      ? modal.habit.schedules.at(-1)!.weekdays
      : [0, 1, 2, 3, 4, 5, 6],
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
    let path = '',
      body: unknown,
      method = 'POST';
    if (modal.kind === 'habit') {
      if (!weekdays.length) {
        setLocalError('VALIDATION_ERROR');
        return;
      }
      path = `/api/habits${modal.habit ? `/${modal.habit.id}` : ''}`;
      method = modal.habit ? 'PATCH' : 'POST';
      body = { title, description, color, weekdays };
    } else if (modal.kind === 'goal') {
      path = `/api/goals${modal.goal ? `/${modal.goal.id}` : ''}`;
      method = modal.goal ? 'PATCH' : 'POST';
      body = { title, description, color };
    } else if (modal.kind === 'step') {
      path = modal.step ? `/api/steps/${modal.step.id}` : `/api/goals/${modal.goal.id}/steps`;
      method = modal.step ? 'PATCH' : 'POST';
      body = { title, date: date || null };
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
          ? { weekdays: modal.habit.schedules.at(-1)!.weekdays }
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
      {modal.kind === 'habit' && (
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
                    weekdays.includes(day) ? weekdays.filter((d) => d !== day) : [...weekdays, day],
                  )
                }
              >
                {t(`weekday${day}`)}
              </button>
            ))}
          </div>
          {modal.habit && <p className="form-hint">{t('scheduleChange')}</p>}
        </fieldset>
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
