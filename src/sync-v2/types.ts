export const RECORD_SYNC_PROTOCOL_VERSION = 2 as const;
export const RECORD_SYNC_STATE_VERSION = 1 as const;

export const CATEGORY_SYNC_FIELDS = ['name', 'sortKey'] as const;
export const TASK_SYNC_FIELDS = ['categoryId', 'title', 'scheduledDates', 'deadlineDate', 'sortKey'] as const;

export type CategorySyncField = (typeof CATEGORY_SYNC_FIELDS)[number];
export type TaskSyncField = (typeof TASK_SYNC_FIELDS)[number];
export type SyncRecordType = 'category' | 'task';

export interface FieldClock {
  at: string;
  deviceId: string;
}

export type FieldClockMap<Field extends string> = Record<Field, FieldClock>;

interface SyncRecordMetadata<Field extends string> {
  id: string;
  updatedAt: string;
  version: number;
  deletedAt: string | null;
  updatedByDeviceId: string;
  fieldUpdatedAt: FieldClockMap<Field>;
  /** Zero until a new local record is accepted; positive values are server assigned. */
  changeSeq: number;
}

export interface CategorySyncRecord extends SyncRecordMetadata<CategorySyncField> {
  recordType: 'category';
  name: string;
  sortKey: string;
}

export interface TaskSyncRecord extends SyncRecordMetadata<TaskSyncField> {
  recordType: 'task';
  categoryId: string;
  title: string;
  scheduledDates: string[];
  deadlineDate: string | null;
  sortKey: string;
}

export type LocalSyncRecord = CategorySyncRecord | TaskSyncRecord;

export interface RemoteRecordIdentity {
  notebookId: string;
  ownerId: string;
}

export type RemoteCategorySyncRecord = CategorySyncRecord & RemoteRecordIdentity;
export type RemoteTaskSyncRecord = TaskSyncRecord & RemoteRecordIdentity;
export type RemoteSyncRecord = RemoteCategorySyncRecord | RemoteTaskSyncRecord;

interface MutationEnvelope {
  mutationId: string;
  notebookId: string;
  ownerId: string;
  expectedVersion: number;
  queuedAt: string;
}

export type RecordMutation =
  | (MutationEnvelope & { recordType: 'category'; record: CategorySyncRecord })
  | (MutationEnvelope & { recordType: 'task'; record: TaskSyncRecord });

interface MutationAcknowledgementEnvelope {
  mutationId: string;
  /** `stale` returns the current canonical row without accepting the mutation. */
  outcome: 'accepted' | 'stale';
}

export type MutationAcknowledgement =
  | (MutationAcknowledgementEnvelope & { recordType: 'category'; record: RemoteCategorySyncRecord })
  | (MutationAcknowledgementEnvelope & { recordType: 'task'; record: RemoteTaskSyncRecord });

export interface ChangeCursor {
  /** Last durably applied server sequence. Sequence gaps are valid. */
  lastChangeSeq: number;
}

export type RecordSyncStatus =
  | 'disabled'
  | 'disconnected'
  | 'catching-up'
  | 'live'
  | 'degraded'
  | 'paused'
  | 'error';

export interface RecordSyncState extends ChangeCursor {
  schemaVersion: typeof RECORD_SYNC_STATE_VERSION;
  deviceId: string;
  accountId: string | null;
  projectRef: string | null;
  notebookId: string | null;
  status: RecordSyncStatus;
  lastError: string | null;
}
