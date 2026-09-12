import type { LocalOutboxEntry } from '../local-db/index.ts';
import type { MutationAcknowledgement, RemoteSyncRecord } from './types.ts';

export interface RecordSyncBinding {
  accountId: string;
  projectRef: string;
  notebookId: string;
}

export interface RecordChange {
  changeSeq: number;
  record: RemoteSyncRecord;
}

export type RecordTransportErrorCode =
  | 'auth-required'
  | 'binding-mismatch'
  | 'permission'
  | 'rate-limited'
  | 'offline'
  | 'server'
  | 'invalid';

export class RecordTransportError extends Error {
  readonly code: RecordTransportErrorCode;
  readonly retriable: boolean;
  readonly cause?: unknown;

  constructor(code: RecordTransportErrorCode, message: string, retriable = false, cause?: unknown) {
    super(message);
    this.name = 'RecordTransportError';
    this.code = code;
    this.retriable = retriable;
    this.cause = cause;
  }
}

export interface RecordSyncTransport {
  readonly binding: RecordSyncBinding;
  assertAuthenticated(): Promise<void>;
  pullChanges(afterChangeSeq: number, limit: number): Promise<RecordChange[]>;
  mutate(entry: LocalOutboxEntry): Promise<MutationAcknowledgement>;
}
