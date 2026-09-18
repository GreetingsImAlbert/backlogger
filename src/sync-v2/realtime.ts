import { getSupabaseClient } from '../supabase/client.ts';
import type { RecordSyncBinding } from './transport.ts';
import type { RecordSyncCycleRunner } from './worker.ts';

type RealtimeEvent = 'INSERT' | 'UPDATE' | 'DELETE';
type RealtimeStatus = 'SUBSCRIBED' | 'TIMED_OUT' | 'CLOSED' | 'CHANNEL_ERROR';

interface RealtimeChannelLike {
  on(
    type: 'postgres_changes',
    filter: { event: RealtimeEvent; schema: 'public'; table: string; filter: string },
    callback: (payload: unknown) => void,
  ): RealtimeChannelLike;
  subscribe(callback: (status: RealtimeStatus, error?: Error) => void): RealtimeChannelLike;
}

interface RealtimeSession {
  access_token: string;
  user: { id: string };
}

interface RealtimeClientLike {
  auth: {
    getSession(): Promise<{ data: { session: RealtimeSession | null } | null; error: unknown | null }>;
    onAuthStateChange(callback: (event: string, session: RealtimeSession | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
  };
  realtime: {
    setAuth(token?: string | null): Promise<void>;
  };
  channel(name: string, options: Record<string, unknown>): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
}

export interface RecordSyncLifecycleSource {
  addEventListener(type: 'focus' | 'online' | 'offline' | 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'focus' | 'online' | 'offline' | 'visibilitychange', listener: () => void): void;
  isVisible(): boolean;
  isOnline(): boolean;
}

export interface SupabaseRealtimeManagerOptions {
  client?: RealtimeClientLike;
  eventDebounceMs?: number;
  connectTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  lifecycle?: RecordSyncLifecycleSource | null;
}

function defaultLifecycle(): RecordSyncLifecycleSource | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  return {
    addEventListener(type, listener) {
      (type === 'visibilitychange' ? document : window).addEventListener(type, listener);
    },
    removeEventListener(type, listener) {
      (type === 'visibilitychange' ? document : window).removeEventListener(type, listener);
    },
    isVisible: () => document.visibilityState !== 'hidden',
    isOnline: () => navigator.onLine,
  };
}

function asClient(value: unknown): RealtimeClientLike {
  return value as RealtimeClientLike;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const parsed = value ?? fallback;
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Realtime ${label} is invalid.`);
  return parsed;
}

function sameBindingUser(binding: RecordSyncBinding, session: RealtimeSession | null): boolean {
  return session === null || session.user.id === binding.accountId;
}

export class SupabaseRealtimeManager {
  private readonly binding: RecordSyncBinding;
  private readonly worker: RecordSyncCycleRunner;
  private readonly client: RealtimeClientLike;
  private readonly lifecycle: RecordSyncLifecycleSource | null;
  private readonly eventDebounceMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private channel: RealtimeChannelLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private cancelPendingConnect: (() => void) | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private started = false;
  private manuallyPaused = false;
  private foreground = true;
  private networkOnline = true;

  constructor(
    binding: RecordSyncBinding,
    worker: RecordSyncCycleRunner,
    options: SupabaseRealtimeManagerOptions = {},
  ) {
    this.binding = { ...binding };
    this.worker = worker;
    const client = options.client ?? getSupabaseClient();
    if (!client) throw new Error('Supabase sync is not configured.');
    this.client = asClient(client);
    this.eventDebounceMs = positiveInteger(options.eventDebounceMs, 75, 'event debounce');
    this.connectTimeoutMs = positiveInteger(options.connectTimeoutMs, 12_000, 'connection timeout');
    this.reconnectBaseMs = positiveInteger(options.reconnectBaseMs, 1_000, 'reconnect delay');
    this.reconnectMaxMs = positiveInteger(options.reconnectMaxMs, 30_000, 'maximum reconnect delay');
    if (this.reconnectMaxMs < this.reconnectBaseMs) {
      throw new Error('Realtime maximum reconnect delay cannot be shorter than its base delay.');
    }
    this.lifecycle = options.lifecycle === undefined ? defaultLifecycle() : options.lifecycle;
    this.foreground = this.lifecycle?.isVisible() ?? true;
    this.networkOnline = this.lifecycle?.isOnline() ?? true;
  }

  private readonly handleFocus = () => {
    if (this.lifecycle?.isVisible() !== false) void this.setLifecycleForeground(true);
  };

  private readonly handleOnline = () => {
    void this.setLifecycleOnline(true);
  };

  private readonly handleOffline = () => {
    void this.setLifecycleOnline(false);
  };

  private readonly handleVisibility = () => {
    void this.setLifecycleForeground(this.lifecycle?.isVisible() !== false);
  };

  private canConnect(): boolean {
    return this.started && !this.manuallyPaused && this.foreground && this.networkOnline;
  }

  private async suspendChannel(): Promise<void> {
    this.clearWakeTimer();
    this.clearReconnectTimer();
    this.worker.stopPeriodicPull();
    await this.removeCurrentChannel();
  }

  private async setLifecycleForeground(foreground: boolean): Promise<void> {
    if (this.foreground === foreground) return;
    this.foreground = foreground;
    if (!foreground) {
      await this.suspendChannel();
      return;
    }
    if (this.canConnect()) await this.connect().catch(() => undefined);
  }

  private async setLifecycleOnline(online: boolean): Promise<void> {
    if (this.networkOnline === online) return;
    this.networkOnline = online;
    if (!online) {
      if (this.manuallyPaused) {
        await this.suspendChannel();
        return;
      }
      await this.disconnect('Realtime is offline.', true);
      return;
    }
    if (this.canConnect()) await this.connect().catch(() => undefined);
  }

  private installLifecycle(): void {
    this.lifecycle?.addEventListener('focus', this.handleFocus);
    this.lifecycle?.addEventListener('online', this.handleOnline);
    this.lifecycle?.addEventListener('offline', this.handleOffline);
    this.lifecycle?.addEventListener('visibilitychange', this.handleVisibility);
  }

  private removeLifecycle(): void {
    this.lifecycle?.removeEventListener('focus', this.handleFocus);
    this.lifecycle?.removeEventListener('online', this.handleOnline);
    this.lifecycle?.removeEventListener('offline', this.handleOffline);
    this.lifecycle?.removeEventListener('visibilitychange', this.handleVisibility);
  }

  private clearWakeTimer(): void {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private scheduleWake(): void {
    if (!this.canConnect() || this.wakeTimer !== null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.worker.runCycle().catch(() => undefined);
    }, this.eventDebounceMs);
  }

  private scheduleReconnect(): void {
    if (!this.canConnect() || this.reconnectTimer !== null) return;
    const delay = Math.min(this.reconnectBaseMs * (2 ** this.reconnectAttempt), this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private async removeCurrentChannel(expectedGeneration?: number): Promise<void> {
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) return;
    this.cancelPendingConnect?.();
    this.cancelPendingConnect = null;
    const channel = this.channel;
    this.channel = null;
    this.generation += 1;
    if (channel) await this.client.removeChannel(channel);
  }

  private async channelFailed(generation: number, message: string): Promise<void> {
    if (generation !== this.generation) return;
    await this.worker.setRealtimeDegraded(message);
    this.worker.startPeriodicPull();
    try {
      await this.removeCurrentChannel(generation);
    } finally {
      this.scheduleReconnect();
    }
  }

  private registerWakeups(channel: RealtimeChannelLike, generation: number): void {
    const filter = `notebook_id=eq.${this.binding.notebookId}`;
    for (const table of ['sync_v2_categories', 'sync_v2_tasks']) {
      for (const event of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        channel.on('postgres_changes', { event, schema: 'public', table, filter }, () => {
          if (generation === this.generation) this.scheduleWake();
        });
      }
    }
  }

  private async openChannel(): Promise<void> {
    if (!this.canConnect() || this.channel) return;
    const channel = this.client.channel(`backlogger-sync-v2:${this.binding.notebookId}`, {
      config: { postgres_changes_options: { wait: true, timeout: 10_000 } },
    });
    this.channel = channel;
    const generation = ++this.generation;
    this.registerWakeups(channel, generation);
    let cancelConnect: (() => void) | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (timeout !== null) clearTimeout(timeout);
          if (error) reject(error);
          else resolve();
        };
        cancelConnect = () => finish(new Error('Realtime connection canceled.'));
        this.cancelPendingConnect = cancelConnect;
        timeout = setTimeout(() => finish(new Error('Realtime connection timed out.')), this.connectTimeoutMs);
        channel.subscribe((status, error) => {
          if (generation !== this.generation) return;
          if (status === 'SUBSCRIBED') {
            finish();
            return;
          }
          const message = status === 'TIMED_OUT'
            ? 'Realtime connection timed out.'
            : status === 'CLOSED'
              ? 'Realtime connection closed.'
              : 'Realtime connection failed.';
          void this.channelFailed(generation, message);
          finish(error ?? new Error(message));
        });
      });
    } finally {
      if (this.cancelPendingConnect === cancelConnect) this.cancelPendingConnect = null;
    }
    if (generation !== this.generation || !this.canConnect()) return;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    await this.worker.setRealtimeDegraded(null);
    await this.worker.runCycle();
    this.worker.startPeriodicPull(false);
  }

  private connect(): Promise<void> {
    if (!this.canConnect() || this.channel) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openChannel().catch(async error => {
      if (!this.canConnect()) return;
      await this.worker.setRealtimeDegraded('Realtime is unavailable; periodic sync is continuing.');
      this.worker.startPeriodicPull();
      if (this.channel) await this.removeCurrentChannel();
      this.scheduleReconnect();
      throw error;
    }).finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private installAuthListener(): void {
    if (this.authUnsubscribe) return;
    const subscription = this.client.auth.onAuthStateChange((event, session) => {
      if (!sameBindingUser(this.binding, session)) {
        void this.disconnect('The signed-in account changed.', true);
        return;
      }
      if (event === 'SIGNED_OUT' || session === null) {
        void this.disconnect('Sign in to resume sync.', true);
        return;
      }
      if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
        void this.client.realtime.setAuth().then(() => {
          if (!this.channel && this.canConnect()) {
            return this.connect();
          }
          return undefined;
        }).catch(() => this.worker.setRealtimeDegraded('Realtime authentication could not be refreshed.'));
      }
    });
    this.authUnsubscribe = () => subscription.data.subscription.unsubscribe();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.installLifecycle();
    this.installAuthListener();
    const response = await this.client.auth.getSession();
    if (response.error || !response.data?.session) {
      await this.worker.setRealtimeDegraded('Sign in to resume sync.');
      return;
    }
    if (!sameBindingUser(this.binding, response.data.session)) {
      await this.worker.setRealtimeDegraded('The signed-in account changed.');
      return;
    }
    // Keep Supabase's access-token callback as the source of truth. Passing the
    // restored token explicitly can leave Realtime using a stale manual token
    // even though Auth has refreshed the persisted session.
    await this.client.realtime.setAuth();
    if (this.canConnect()) await this.connect().catch(() => undefined);
  }

  async pause(): Promise<void> {
    this.manuallyPaused = true;
    await this.suspendChannel();
  }

  async resume(): Promise<void> {
    if (!this.started) return;
    this.manuallyPaused = false;
    this.foreground = this.lifecycle?.isVisible() ?? true;
    this.networkOnline = this.lifecycle?.isOnline() ?? true;
    if (this.canConnect()) await this.connect().catch(() => undefined);
  }

  private async disconnect(message: string, stopPolling: boolean): Promise<void> {
    this.clearWakeTimer();
    this.clearReconnectTimer();
    if (stopPolling) this.worker.stopPeriodicPull();
    await this.worker.setRealtimeDegraded(message);
    await this.removeCurrentChannel();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.manuallyPaused = true;
    this.removeLifecycle();
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.clearWakeTimer();
    this.clearReconnectTimer();
    this.worker.stopPeriodicPull();
    await this.removeCurrentChannel();
  }
}
