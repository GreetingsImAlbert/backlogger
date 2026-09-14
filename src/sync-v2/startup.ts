import { RecordTransportError } from './transport.ts';

const STARTUP_RETRY_BASE_MS = 1_000;
const STARTUP_RETRY_MAX_MS = 30_000;

export function recordSyncStartupRetryDelay(error: unknown, attempt: number): number | null {
  const retriable = error instanceof RecordTransportError
    ? error.retriable
    : error instanceof Error && /network|offline|timeout|timed out|connection|sign in|auth/i.test(error.message);
  if (!retriable) return null;
  const boundedAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? Math.min(attempt, 30) : 0;
  return Math.min(STARTUP_RETRY_BASE_MS * (2 ** boundedAttempt), STARTUP_RETRY_MAX_MS);
}

/** Coalesce duplicate INITIAL_SESSION/getSession notifications into one startup operation. */
export class RecordSyncStartupGate {
  private current: Promise<void> | null = null;

  run(operation: () => Promise<void>): Promise<void> {
    if (this.current) return this.current;
    const tracked = Promise.resolve().then(operation).finally(() => {
      if (this.current === tracked) this.current = null;
    });
    this.current = tracked;
    return tracked;
  }
}
