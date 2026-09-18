export interface RecordSyncExecutionWorker {
  runCycle(): Promise<unknown>;
  startPeriodicPull(runImmediately?: boolean): void;
  stopPeriodicPull(): void;
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
