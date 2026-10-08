import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DomainError, documentWithinLimits, dueReminders } from '@machbar/shared';
import type { Config } from './config.js';
import { JsonStore } from './store.js';
import { StorageBudget } from './storage-budget.js';
import {
  createPushSender,
  subscriptionSchema,
  validateEndpoint,
  type EndpointValidator,
  type PushPayload,
  type PushSender,
} from './push-transport.js';

const bindingSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  subscription: subscriptionSchema,
  lastTestAt: z.number().optional(),
});
const stateSchema = z.object({
  bindings: z.array(bindingSchema).max(10_000),
  dispatches: z.record(
    z.string(),
    z.object({ expiresAt: z.number(), attempts: z.number(), retryAt: z.number().nullable() }),
  ),
});
type State = z.infer<typeof stateSchema>;
type Binding = z.infer<typeof bindingSchema>;

export class PushStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private budget = new StorageBudget(directory),
  ) {}
  private async load(): Promise<State> {
    try {
      return stateSchema.parse(
        JSON.parse(await readFile(join(this.directory, 'push-state.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { bindings: [], dispatches: {} };
      throw new DomainError('PUSH_DATA_CORRUPT', 500);
    }
  }
  async access<T>(
    action: (state: State) => T,
    write: boolean | ((result: T) => boolean) = false,
  ): Promise<T> {
    const next = this.queue
      .catch(() => {})
      .then(async () => {
        const state = await this.load();
        const result = action(state);
        if (typeof write === 'function' ? write(result) : write) {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          const target = join(this.directory, 'push-state.json');
          const temp = `${target}.${randomUUID()}.tmp`;
          const contents = JSON.stringify(state);
          if (Buffer.byteLength(contents) > 32 * 1024 * 1024)
            throw new DomainError('STORAGE_LIMIT', 507);
          await this.budget.commit(target, Buffer.byteLength(contents), async () => {
            try {
              const file = await open(temp, 'wx', 0o600);
              try {
                await file.writeFile(contents);
                await file.sync();
              } finally {
                await file.close();
              }
              await rename(temp, target);
              const directory = await open(this.directory, 'r');
              try {
                await directory.sync();
              } finally {
                await directory.close();
              }
            } finally {
              await unlink(temp).catch(() => {});
            }
          });
        }
        return result;
      });
    this.queue = next;
    return next;
  }
}

export class ReminderScheduler {
  private running: Promise<void> | undefined;
  private stopped = false;
  private bindingOffset = 0;
  private reminderOffsets = new Map<string, number>();
  constructor(
    private push: PushStore,
    private profiles: JsonStore,
    private send: PushSender,
    private clock: () => Date = () => new Date(),
    private report: () => void = () => {},
  ) {}
  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  async stop() {
    this.stopped = true;
    await this.running;
  }
  private async run() {
    const now = this.clock();
    const bindings = await this.push.access((state) => {
      for (const [key, value] of Object.entries(state.dispatches))
        if (value.expiresAt <= now.getTime()) delete state.dispatches[key];
      return state.bindings;
    }, true);
    const activeBindings = new Set(bindings.map((binding) => binding.id));
    for (const id of this.reminderOffsets.keys())
      if (!activeBindings.has(id)) this.reminderOffsets.delete(id);
    const reminders = new Map<string, ReturnType<typeof dueReminders>>();
    const started = performance.now();
    let inspected = 0,
      sent = 0;
    const start = this.bindingOffset % Math.max(1, bindings.length);
    for (let index = 0; index < bindings.length; index++) {
      const offset = (start + index) % bindings.length;
      const binding = bindings[offset]!;
      if (this.stopped) return;
      try {
        let due = reminders.get(binding.userId);
        if (!due) {
          const doc = await this.profiles.readExisting(binding.userId);
          // Legacy oversized profiles stay readable, but cannot monopolize a tick.
          due = documentWithinLimits(doc) ? dueReminders(doc, now) : [];
          reminders.set(binding.userId, due);
        }
        inspected++;
        let bindingInspected = 0,
          bindingSent = 0;
        const savedOffset = this.reminderOffsets.get(binding.id) ?? 0;
        let item = savedOffset < due.length ? savedOffset : 0;
        for (; item < due.length; item++) {
          if (this.stopped) return;
          if (inspected >= 500 || sent >= 50 || performance.now() - started >= 1000) {
            // A slow destination uses up this tick, but never owns the next one.
            this.bindingOffset = (offset + 1) % bindings.length;
            this.reminderOffsets.set(binding.id, item);
            return;
          }
          // Rotate even when transport is fast. Keep each device's progress so
          // large backlogs and already-claimed receipts cannot starve others.
          if (bindingInspected >= 50 || bindingSent >= 10) break;
          inspected++;
          bindingInspected++;
          const reminder = due[item]!;
          const key = `${binding.id}:${reminder.habitId}:${reminder.date}`;
          const claimed = await this.push.access((state) => {
            if (!state.bindings.some((b) => b.id === binding.id)) return false;
            const previous = state.dispatches[key];
            if (previous && (previous.retryAt === null || previous.retryAt > now.getTime()))
              return false;
            if (!previous && Object.keys(state.dispatches).length >= 100_000) return false;
            // A durable claim survives process crashes. Ambiguous transport failures
            // are not retried because the push service might have accepted them.
            state.dispatches[key] = {
              expiresAt: reminder.expiresAt,
              attempts: (previous?.attempts ?? 0) + 1,
              retryAt: null,
            };
            return true;
          }, true);
          if (!claimed) continue;
          const payload: PushPayload = {
            version: 1,
            bindingId: binding.id,
            title: 'Machbar',
            body: reminder.title,
            tag: key,
            expiresAt: reminder.expiresAt,
          };
          const ttl = Math.floor((reminder.expiresAt - this.clock().getTime()) / 1000);
          if (ttl <= 0) continue;
          sent++;
          bindingSent++;
          try {
            await this.send(binding.subscription, payload, ttl, topicFor(key));
          } catch (error) {
            const status = pushStatus(error);
            await this.push.access((state) => {
              if (status === 404 || status === 410) removeBinding(state, binding.id);
              else if (
                status === 429 ||
                (status !== undefined && status >= 500) ||
                (typeof error === 'object' &&
                  error !== null &&
                  'retryable' in error &&
                  error.retryable === true)
              ) {
                const dispatch = state.dispatches[key];
                if (dispatch)
                  dispatch.retryAt =
                    this.clock().getTime() +
                    Math.min(3600, 60 * 2 ** Math.min(dispatch.attempts - 1, 6)) * 1000;
              }
            }, true);
            this.report();
          }
        }
        if (item < due.length) this.reminderOffsets.set(binding.id, item);
        else this.reminderOffsets.delete(binding.id);
      } catch {
        this.report();
      }
      this.bindingOffset = (offset + 1) % bindings.length;
      if (inspected >= 500 || sent >= 50 || performance.now() - started >= 1000) return;
    }
  }
}
function topicFor(key: string) {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}
function pushStatus(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    typeof error.statusCode === 'number'
    ? error.statusCode
    : undefined;
}
function removeBinding(state: State, id: string) {
  state.bindings = state.bindings.filter((binding) => binding.id !== id);
  for (const key of Object.keys(state.dispatches))
    if (key.startsWith(`${id}:`)) delete state.dispatches[key];
}

export type NotificationOptions = {
  send?: PushSender;
  validate?: EndpointValidator;
  clock?: () => Date;
  schedule?: boolean;
};
export function registerNotifications(
  app: FastifyInstance,
  config: Config,
  profiles: JsonStore,
  options: NotificationOptions = {},
  budget = new StorageBudget(config.dataDir, config),
) {
  const push = new PushStore(config.dataDir, budget);
  const sender = options.send ?? (config.vapid ? createPushSender(config.vapid) : undefined);
  const clock = options.clock ?? (() => new Date());
  const ready = () => {
    if (!config.vapid || !sender) throw new DomainError('NOTIFICATIONS_UNAVAILABLE', 503);
    return sender;
  };
  const bindingBody = z.object({ bindingId: z.string().uuid() }).strict();
  const owned = (state: State, userId: string, id: string): Binding => {
    const binding = state.bindings.find((b) => b.id === id && b.userId === userId);
    if (!binding) throw new DomainError('NOT_FOUND', 404);
    return binding;
  };
  app.get('/api/notifications/config', async () => ({
    available: !!config.vapid,
    publicKey: config.vapid?.publicKey ?? null,
  }));
  app.put('/api/notifications/subscription', async (request) => {
    ready();
    const { subscription } = z
      .object({ subscription: subscriptionSchema })
      .strict()
      .parse(request.body);
    await profiles.readExisting(request.userId);
    try {
      await (options.validate ?? validateEndpoint)(subscription.endpoint);
    } catch {
      throw new DomainError('VALIDATION_ERROR', 400);
    }
    return push.access((state) => {
      const existing = state.bindings.find(
        (b) => b.subscription.endpoint === subscription.endpoint,
      );
      if (existing && existing.userId !== request.userId)
        throw new DomainError('ACCOUNT_CHANGED', 409);
      if (existing) {
        existing.subscription = subscription;
        return { bindingId: existing.id };
      }
      if (
        state.bindings.length >= 10_000 ||
        state.bindings.filter((b) => b.userId === request.userId).length >= 32
      )
        throw new DomainError('NOTIFICATION_DEVICE_LIMIT', 409);
      const id = randomUUID();
      state.bindings.push({ id, userId: request.userId, subscription });
      return { bindingId: id };
    }, true);
  });
  app.delete('/api/notifications/subscription', async (request) => {
    const { bindingId } = bindingBody.parse(request.body);
    await profiles.readExisting(request.userId);
    await push.access(
      (state) => {
        const binding = state.bindings.find((b) => b.id === bindingId);
        if (!binding) return false;
        if (binding.userId !== request.userId) throw new DomainError('NOT_FOUND', 404);
        removeBinding(state, bindingId);
        return true;
      },
      (removed) => removed,
    );
    return { ok: true };
  });
  app.post('/api/notifications/test', async (request) => {
    const send = ready();
    const { bindingId } = bindingBody.parse(request.body);
    const doc = await profiles.readExisting(request.userId);
    const now = clock().getTime();
    const binding = await push.access((state) => {
      const binding = owned(state, request.userId, bindingId);
      if (binding.lastTestAt !== undefined && now - binding.lastTestAt < 60_000)
        throw new DomainError('RATE_LIMITED', 429);
      binding.lastTestAt = now;
      return binding;
    }, true);
    try {
      await send(
        binding.subscription,
        {
          version: 1,
          bindingId,
          title: 'Machbar',
          body:
            doc.preferences.language === 'de'
              ? 'Benachrichtigungen sind bereit für deine kleinen Erfolge.'
              : 'Notifications are ready for your small wins.',
          tag: `${bindingId}:test`,
          expiresAt: now + 300_000,
        },
        300,
        topicFor(`${bindingId}:test`),
      );
    } catch (error) {
      if ([404, 410].includes(pushStatus(error) ?? 0))
        await push.access((state) => removeBinding(state, bindingId), true);
      throw new DomainError('NOTIFICATION_DELIVERY_FAILED', 502);
    }
    return { ok: true };
  });
  if (config.vapid && sender && options.schedule !== false) {
    const scheduler = new ReminderScheduler(push, profiles, sender, clock, () =>
      app.log.warn('Habit notification dispatch failed.'),
    );
    let timer: ReturnType<typeof setInterval>;
    app.addHook('onReady', async () => {
      // Load before accepting traffic, so corrupt push state cannot silently erase subscriptions.
      await push.access(() => undefined);
      const tick = () => {
        void scheduler.tick().catch(() => app.log.error('Notification scheduler failed.'));
      };
      timer = setInterval(tick, 60_000);
      timer.unref();
      tick();
    });
    app.addHook('onClose', async () => {
      clearInterval(timer);
      await scheduler.stop();
    });
  }
}
