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
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private channel: RealtimeChannelLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private authUnsubscribe: (() => void) | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private started = false;
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
    if (this.lifecycle?.isVisible() !== false) void this.resume();
  };

  private readonly handleOnline = () => {
    this.networkOnline = true;
    if (this.lifecycle?.isVisible() !== false) void this.resume();
  };

  private readonly handleOffline = () => {
    this.networkOnline = false;
    void this.disconnect('Realtime is offline.', true);
  };

  private readonly handleVisibility = () => {
    if (this.lifecycle?.isVisible() === false) void this.pause();
    else void this.resume();
  };

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
    if (!this.started || !this.foreground || !this.networkOnline || this.wakeTimer !== null) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      void this.worker.runCycle().catch(() => undefined);
    }, this.eventDebounceMs);
  }

  private scheduleReconnect(): void {
    if (!this.started || !this.foreground || !this.networkOnline || this.reconnectTimer !== null) return;
    const delay = Math.min(this.reconnectBaseMs * (2 ** this.reconnectAttempt), this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => undefined);
    }, delay);
  }

  private async removeCurrentChannel(expectedGeneration?: number): Promise<void> {
    if (expectedGeneration !== undefined && expectedGeneration !== this.generation) return;
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
    if (!this.started || !this.foreground || !this.networkOnline || this.channel) return;
    const channel = this.client.channel(`backlogger-sync-v2:${this.binding.notebookId}`, {
      config: { postgres_changes_options: { wait: true, timeout: 10_000 } },
    });
    this.channel = channel;
    const generation = ++this.generation;
    this.registerWakeups(channel, generation);
    await new Promise<void>((resolve, reject) => {
      channel.subscribe((status, error) => {
        if (generation !== this.generation) return;
        if (status === 'SUBSCRIBED') {
          resolve();
          return;
        }
        const message = status === 'TIMED_OUT'
          ? 'Realtime connection timed out.'
          : status === 'CLOSED'
            ? 'Realtime connection closed.'
            : 'Realtime connection failed.';
        void this.channelFailed(generation, message);
        reject(error ?? new Error(message));
      });
    });
    if (generation !== this.generation || !this.started || !this.foreground) return;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    await this.worker.setRealtimeDegraded(null);
    await this.worker.runCycle();
    this.worker.startPeriodicPull(false);
  }

  private connect(): Promise<void> {
    if (!this.started || !this.foreground || !this.networkOnline || this.channel) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openChannel().catch(async error => {
      await this.worker.setRealtimeDegraded('Realtime is unavailable; periodic sync is continuing.');
      this.worker.startPeriodicPull();
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
        void this.client.realtime.setAuth(session.access_token).then(() => {
          if (!this.channel && this.started && this.foreground && this.networkOnline) {
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
    await this.client.realtime.setAuth(response.data.session.access_token);
    if (this.foreground && this.networkOnline) await this.connect().catch(() => undefined);
  }

  async pause(): Promise<void> {
    this.foreground = false;
    this.clearWakeTimer();
    this.clearReconnectTimer();
    this.worker.stopPeriodicPull();
    await this.removeCurrentChannel();
  }

  async resume(): Promise<void> {
    if (!this.started) return;
    this.foreground = this.lifecycle?.isVisible() ?? true;
    this.networkOnline = this.lifecycle?.isOnline() ?? true;
    if (!this.foreground || !this.networkOnline) return;
    await this.connect().catch(() => undefined);
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
    this.removeLifecycle();
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.clearWakeTimer();
    this.clearReconnectTimer();
    this.worker.stopPeriodicPull();
    await this.removeCurrentChannel();
  }
}
