import type { LocalOutboxEntry, LocalRepository } from '../local-db/index.ts';
import type { LocalRepositoryTransaction } from '../local-db/types.ts';
import { reconcileRecord } from './merge.ts';
import { parseRemoteSyncRecord } from './validation.ts';
import {
  RecordTransportError,
  type RecordChange,
  type RecordSyncBinding,
  type RecordSyncTransport,
} from './transport.ts';

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_STALE_ATTEMPTS = 3;
const MAX_PAGES_PER_PULL = 10_000;

export interface RecordSyncCycleResult {
  pulled: number;
  pushed: number;
  staleResponses: number;
  lastChangeSeq: number;
}

export interface RecordSyncWorkerOptions {
  pageSize?: number;
  pollIntervalMs?: number;
  maxStaleAttempts?: number;
  now?: () => string;
  onLocalCommit?: () => void | Promise<void>;
}

export interface RecordSyncCycleRunner {
  runCycle(): Promise<RecordSyncCycleResult>;
  startPeriodicPull(runImmediately?: boolean): void;
  stopPeriodicPull(): void;
  markCatchingUp(): Promise<void>;
  setRealtimeDegraded(message: string | null): Promise<void>;
}

function bindingMatches(first: RecordSyncBinding, second: RecordSyncBinding): boolean {
  return first.accountId === second.accountId
    && first.projectRef === second.projectRef
    && first.notebookId === second.notebookId;
}

function safeError(error: unknown): string {
  return error instanceof RecordTransportError
    ? error.message
    : 'Record sync failed. Local changes are safely queued.';
}

function validatePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} must be a positive integer.`);
  return value as number;
}

function normalizedPage(
  page: readonly RecordChange[],
  binding: RecordSyncBinding,
  afterChangeSeq: number,
  now: number,
): RecordChange[] {
  const bySequence = new Map<number, RecordChange>();
  for (const candidate of page) {
    if (typeof candidate !== 'object' || candidate === null) throw new Error('A record delta is invalid.');
    const changeSeq = validatePositiveInteger(candidate.changeSeq, 'Record delta sequence');
    const record = parseRemoteSyncRecord(candidate.record, {
      expectedNotebookId: binding.notebookId,
      expectedOwnerId: binding.accountId,
      now,
    });
    if (record.changeSeq !== changeSeq) throw new Error('A record delta has mismatched sequence metadata.');
    const change = { changeSeq, record };
    const existing = bySequence.get(changeSeq);
    if (existing && JSON.stringify(existing.record) !== JSON.stringify(record)) {
      throw new Error('A record delta sequence contains conflicting payloads.');
    }
    bySequence.set(changeSeq, change);
  }
  return [...bySequence.values()]
    .filter(change => change.changeSeq > afterChangeSeq)
    .sort((first, second) => first.changeSeq - second.changeSeq);
}

function entryMatchesBinding(entry: LocalOutboxEntry, binding: RecordSyncBinding): boolean {
  return entry.accountId === binding.accountId
    && entry.projectRef === binding.projectRef
    && entry.notebookId === binding.notebookId;
}

function assertTransactionBinding(
  transaction: LocalRepositoryTransaction,
  binding: RecordSyncBinding,
): void {
  const state = transaction.getSyncState();
  const current = {
    accountId: state.accountId ?? '',
    projectRef: state.projectRef ?? '',
    notebookId: state.notebookId ?? '',
  };
  if (!bindingMatches(current, binding)) {
    throw new RecordTransportError('binding-mismatch', 'The local sync binding changed during synchronization.');
  }
}

export class RecordSyncWorker {
  private readonly repository: LocalRepository;
  private readonly transport: RecordSyncTransport;
  private readonly binding: RecordSyncBinding;
  private readonly pageSize: number;
  private readonly pollIntervalMs: number;
  private readonly maxStaleAttempts: number;
  private readonly now: () => string;
  private readonly onLocalCommit: () => void | Promise<void>;
  private cycleQueue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private realtimeError: string | null = null;

  constructor(
    repository: LocalRepository,
    transport: RecordSyncTransport,
    options: RecordSyncWorkerOptions = {},
  ) {
    this.repository = repository;
    this.transport = transport;
    this.binding = { ...transport.binding };
    this.pageSize = this.positiveOption(options.pageSize, DEFAULT_PAGE_SIZE, 1000, 'page size');
    this.pollIntervalMs = this.positiveOption(
      options.pollIntervalMs,
      DEFAULT_POLL_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
      'poll interval',
    );
    this.maxStaleAttempts = this.positiveOption(
      options.maxStaleAttempts,
      DEFAULT_STALE_ATTEMPTS,
      100,
      'stale attempt limit',
    );
    this.now = options.now ?? (() => new Date().toISOString());
    this.onLocalCommit = options.onLocalCommit ?? (() => undefined);
  }

  private positiveOption(value: number | undefined, fallback: number, maximum: number, label: string): number {
    const parsed = value ?? fallback;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
      throw new Error(`Record sync ${label} is invalid.`);
    }
    return parsed;
  }

  private async assertLocalBinding(): Promise<void> {
    const state = (await this.repository.readModel()).syncState;
    const localBinding = {
      accountId: state.accountId ?? '',
      projectRef: state.projectRef ?? '',
      notebookId: state.notebookId ?? '',
    };
    if (!bindingMatches(localBinding, this.binding)) {
      throw new RecordTransportError('binding-mismatch', 'The local sync binding does not match this worker.');
    }
  }

  private async setStatus(status: 'catching-up' | 'live' | 'degraded' | 'error', lastError: string | null): Promise<void> {
    await this.repository.transaction(transaction => {
      const state = transaction.getSyncState();
      const localBinding = {
        accountId: state.accountId ?? '',
        projectRef: state.projectRef ?? '',
        notebookId: state.notebookId ?? '',
      };
      if (bindingMatches(localBinding, this.binding)) transaction.setSyncState({ ...state, status, lastError });
    });
    await this.onLocalCommit();
  }

  private validationNow(): number {
    const now = Date.parse(this.now());
    if (!Number.isFinite(now)) throw new Error('The record sync clock is invalid.');
    return now;
  }

  private async pullAll(): Promise<number> {
    let pulled = 0;
    let pageCount = 0;
    let cursor = (await this.repository.readModel()).syncState.lastChangeSeq;
    while (pageCount < MAX_PAGES_PER_PULL) {
      const rawPage = await this.transport.pullChanges(cursor, this.pageSize);
      if (!Array.isArray(rawPage)) throw new Error('The record transport returned an invalid delta page.');
      const page = normalizedPage(rawPage, this.binding, cursor, this.validationNow());
      if (page.length === 0) return pulled;
      const nextCursor = page.at(-1)!.changeSeq;
      await this.repository.transaction(transaction => {
        assertTransactionBinding(transaction, this.binding);
        for (const change of page) {
          const local = transaction.getRecord(change.record.recordType, change.record.id);
          const base = transaction.getBase(change.record.recordType, change.record.id);
          transaction.applyReconciliation(reconcileRecord(base, local, change.record, { now: this.validationNow() }));
        }
        transaction.setCursor(nextCursor);
      });
      await this.onLocalCommit();
      pulled += page.length;
      cursor = nextCursor;
      pageCount += 1;
      if (rawPage.length < this.pageSize) return pulled;
    }
    throw new Error('Record sync exceeded its delta pagination safety limit.');
  }

  private async markFailureIfCurrent(entry: LocalOutboxEntry, error: string): Promise<void> {
    await this.repository.transaction(transaction => {
      const current = transaction.listOutbox().find(candidate => candidate.mutationId === entry.mutationId);
      if (!current) return;
      transaction.markOutboxAttempt({
        mutationId: entry.mutationId,
        recordType: entry.recordType,
        recordId: entry.recordId,
        attemptedAt: this.now(),
        error,
      });
    });
  }

  private async reconcileStale(entry: LocalOutboxEntry, serverRecord: RecordChange['record']): Promise<boolean> {
    return this.repository.transaction(transaction => {
      assertTransactionBinding(transaction, this.binding);
      const currentEntry = transaction.listOutbox().find(candidate => (
        candidate.recordType === entry.recordType
        && candidate.recordId === entry.recordId
        && entryMatchesBinding(candidate, this.binding)
      ));
      const local = transaction.getRecord(entry.recordType, entry.recordId);
      if (!local) throw new Error('A stale mutation has no matching local record.');
      const base = transaction.getBase(entry.recordType, entry.recordId);
      transaction.applyReconciliation(reconcileRecord(base, local, serverRecord, { now: this.validationNow() }));
      return currentEntry !== undefined;
    });
  }

  private async drainOutbox(): Promise<{ pushed: number; staleResponses: number }> {
    let pushed = 0;
    let staleResponses = 0;
    while (true) {
      const entry = (await this.repository.listOutbox()).find(candidate => entryMatchesBinding(candidate, this.binding));
      if (!entry) return { pushed, staleResponses };

      let staleAttempts = 0;
      while (staleAttempts < this.maxStaleAttempts) {
        const current = (await this.repository.listOutbox()).find(candidate => (
          candidate.recordType === entry.recordType
          && candidate.recordId === entry.recordId
          && entryMatchesBinding(candidate, this.binding)
        ));
        if (!current) break;
        let acknowledgement;
        try {
          acknowledgement = await this.transport.mutate(current);
        } catch (error) {
          await this.markFailureIfCurrent(current, safeError(error));
          throw error;
        }
        if (acknowledgement.outcome === 'accepted') {
          const result = await this.repository.transaction(transaction => transaction.acknowledgeMutation(acknowledgement));
          if (result === 'accepted') {
            pushed += 1;
            await this.onLocalCommit();
          }
          break;
        }

        staleAttempts += 1;
        staleResponses += 1;
        await this.reconcileStale(current, acknowledgement.record);
        await this.onLocalCommit();
      }

      const remaining = (await this.repository.listOutbox()).find(candidate => (
        candidate.recordType === entry.recordType
        && candidate.recordId === entry.recordId
        && entryMatchesBinding(candidate, this.binding)
      ));
      if (remaining && staleAttempts >= this.maxStaleAttempts) {
        const message = 'Cloud record kept changing; retry is deferred.';
        await this.markFailureIfCurrent(remaining, message);
        throw new RecordTransportError('server', message, true);
      }
    }
  }

  private async executeCycle(): Promise<RecordSyncCycleResult> {
    await this.assertLocalBinding();
    await this.setStatus('catching-up', null);
    try {
      await this.transport.assertAuthenticated();
      const pulledBeforePush = await this.pullAll();
      const pushed = await this.drainOutbox();
      const pulledAfterPush = await this.pullAll();
      await this.setStatus(this.realtimeError === null ? 'live' : 'degraded', this.realtimeError);
      return {
        pulled: pulledBeforePush + pulledAfterPush,
        pushed: pushed.pushed,
        staleResponses: pushed.staleResponses,
        lastChangeSeq: (await this.repository.readModel()).syncState.lastChangeSeq,
      };
    } catch (error) {
      const degraded = error instanceof RecordTransportError && error.retriable;
      await this.setStatus(degraded ? 'degraded' : 'error', safeError(error));
      throw error;
    }
  }

  runCycle(): Promise<RecordSyncCycleResult> {
    const result = this.cycleQueue.then(() => this.executeCycle(), () => this.executeCycle());
    this.cycleQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  startPeriodicPull(runImmediately = true): void {
    if (this.timer !== null) return;
    if (runImmediately) void this.runCycle().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.runCycle().catch(() => undefined);
    }, this.pollIntervalMs);
  }

  stopPeriodicPull(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async markCatchingUp(): Promise<void> {
    await this.setStatus('catching-up', null);
  }

  async setRealtimeDegraded(message: string | null): Promise<void> {
    this.realtimeError = message;
    if (message !== null) await this.setStatus('degraded', message);
  }
}
