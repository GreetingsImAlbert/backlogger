export interface RecordSyncExecutionWorker {
  runCycle(): Promise<unknown>;
  startPeriodicPull(runImmediately?: boolean): void;
  stopPeriodicPull(): void;
  markCatchingUp?(): Promise<void>;
  setRealtimeDegraded?(message: string | null): Promise<void>;
}

export interface RecordSyncRealtimeRuntime {
  start(): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

async function runPollingCycle(worker: RecordSyncExecutionWorker): Promise<void> {
  await worker.runCycle().then(() => undefined, () => undefined);
}

export interface RecordSyncExecutionControllerOptions {
  foreground?: boolean;
  online?: boolean;
}

/**
 * Serializes app lifecycle and user Pause/Resume transitions around one worker.
 * Realtime changes latency only: every active state retains periodic cursor pulls.
 */
export class RecordSyncExecutionController {
  private readonly worker: RecordSyncExecutionWorker;
  private readonly realtime: RecordSyncRealtimeRuntime | null;
  private transitionQueue: Promise<void> = Promise.resolve();
  private started = false;
  private realtimeStarted = false;
  private active = false;
  private manuallyPaused = false;
  private foreground: boolean;
  private online: boolean;

  constructor(
    worker: RecordSyncExecutionWorker,
    realtime: RecordSyncRealtimeRuntime | null,
    options: RecordSyncExecutionControllerOptions = {},
  ) {
    this.worker = worker;
    this.realtime = realtime;
    this.foreground = options.foreground ?? true;
    this.online = options.online ?? true;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.transitionQueue.then(operation, operation);
    this.transitionQueue = next.catch(() => undefined);
    return next;
  }

  private async activate(): Promise<void> {
    if (this.active) return;
    await this.worker.markCatchingUp?.();
    if (this.realtime) {
      if (this.realtimeStarted) await this.realtime.resume();
      else {
        this.realtimeStarted = true;
        await this.realtime.start();
      }
    } else {
      this.worker.startPeriodicPull(false);
      await runPollingCycle(this.worker);
    }
    this.active = true;
  }

  private async deactivate(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    if (this.realtime && this.realtimeStarted) await this.realtime.pause();
    else this.worker.stopPeriodicPull();
  }

  private async reconcile(): Promise<void> {
    const shouldBeActive = this.started && !this.manuallyPaused && this.foreground && this.online;
    if (shouldBeActive) {
      await this.activate();
      return;
    }
    await this.deactivate();
    if (this.started && !this.manuallyPaused && !this.online) {
      await this.worker.setRealtimeDegraded?.('Cloud sync is offline.');
    }
  }

  start(): Promise<void> {
    return this.enqueue(async () => {
      if (this.started) return;
      this.started = true;
      await this.reconcile();
    });
  }

  pause(): Promise<void> {
    return this.enqueue(async () => {
      this.manuallyPaused = true;
      await this.reconcile();
    });
  }

  resume(): Promise<void> {
    return this.enqueue(async () => {
      this.manuallyPaused = false;
      await this.reconcile();
    });
  }

  setForeground(foreground: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.foreground === foreground) return;
      this.foreground = foreground;
      await this.reconcile();
    });
  }

  setOnline(online: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.online === online) return;
      this.online = online;
      await this.reconcile();
    });
  }

  stop(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.started && !this.realtimeStarted) return;
      this.started = false;
      this.active = false;
      this.worker.stopPeriodicPull();
      if (this.realtime && this.realtimeStarted) await this.realtime.stop();
      this.realtimeStarted = false;
    });
  }
}

export async function startRecordSyncExecution(
  worker: RecordSyncExecutionWorker,
  realtime: RecordSyncRealtimeRuntime | null,
): Promise<void> {
  if (realtime) {
    await realtime.start();
    return;
  }
  worker.startPeriodicPull(false);
  await runPollingCycle(worker);
}

export async function pauseRecordSyncExecution(
  worker: RecordSyncExecutionWorker,
  realtime: RecordSyncRealtimeRuntime | null,
): Promise<void> {
  if (realtime) await realtime.pause();
  else worker.stopPeriodicPull();
}

export async function resumeRecordSyncExecution(
  worker: RecordSyncExecutionWorker,
  realtime: RecordSyncRealtimeRuntime | null,
): Promise<void> {
  if (realtime) {
    await realtime.resume();
    return;
  }
  worker.startPeriodicPull(false);
  await runPollingCycle(worker);
}

export async function stopRecordSyncExecution(
  worker: RecordSyncExecutionWorker | null,
  realtime: RecordSyncRealtimeRuntime | null,
): Promise<void> {
  worker?.stopPeriodicPull();
  if (realtime) await realtime.stop();
}
