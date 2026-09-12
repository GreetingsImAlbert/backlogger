import { normalizeDates, parseDate } from '../dates.ts';
import {
  CATEGORY_SYNC_FIELDS,
  RECORD_SYNC_STATE_VERSION,
  TASK_SYNC_FIELDS,
  type CategorySyncField,
  type CategorySyncRecord,
  type ChangeCursor,
  type FieldClock,
  type FieldClockMap,
  type LocalSyncRecord,
  type MutationAcknowledgement,
  type RecordMutation,
  type RecordSyncState,
  type RecordSyncStatus,
  type RemoteCategorySyncRecord,
  type RemoteRecordIdentity,
  type RemoteSyncRecord,
  type RemoteTaskSyncRecord,
  type TaskSyncField,
  type TaskSyncRecord,
} from './types.ts';

export const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const LOCAL_METADATA_KEYS = [
  'recordType',
  'id',
  'updatedAt',
  'version',
  'deletedAt',
  'updatedByDeviceId',
  'fieldUpdatedAt',
  'changeSeq',
] as const;
const REMOTE_IDENTITY_KEYS = ['notebookId', 'ownerId'] as const;
const CATEGORY_KEYS = [...LOCAL_METADATA_KEYS, 'name', 'sortKey'] as const;
const TASK_KEYS = [...LOCAL_METADATA_KEYS, 'categoryId', 'title', 'scheduledDates', 'deadlineDate', 'sortKey'] as const;

export interface ClockValidationOptions {
  /** Injectable wall clock for deterministic validation tests. */
  now?: number;
}

export interface RemoteRecordValidationOptions extends ClockValidationOptions {
  expectedNotebookId: string;
  expectedOwnerId: string;
}

export interface RecordSyncStateValidationOptions {
  expectedAccountId?: string;
  expectedProjectRef?: string;
  expectedNotebookId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).find(key => !allowedKeys.has(key));
  if (unexpected) throw new Error(`${label} has an unsupported ${unexpected} field.`);
  const missing = allowed.find(key => !Object.hasOwn(value, key));
  if (missing) throw new Error(`${label} is missing its ${missing} field.`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : requiredString(value, label);
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative safe integer.`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonnegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive.`);
  return parsed;
}

function canonicalTimestamp(value: unknown, label: string, options: ClockValidationOptions): string {
  if (typeof value !== 'string') throw new Error(`${label} must be an ISO timestamp.`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  if (timestamp > (options.now ?? Date.now()) + MAX_FUTURE_CLOCK_SKEW_MS) {
    throw new Error(`${label} is too far in the future.`);
  }
  return value;
}

function nullableTimestamp(value: unknown, label: string, options: ClockValidationOptions): string | null {
  return value === null ? null : canonicalTimestamp(value, label, options);
}

function calendarDate(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a calendar date.`);
  try {
    parseDate(value);
  } catch {
    throw new Error(`${label} must be a valid YYYY-MM-DD calendar date.`);
  }
  return value;
}

function nullableCalendarDate(value: unknown, label: string): string | null {
  return value === null ? null : calendarDate(value, label);
}

function scheduledDates(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  const parsed = value.map((item, index) => calendarDate(item, `${label}[${index}]`));
  const normalized = normalizeDates(parsed);
  if (normalized.length !== parsed.length || normalized.some((date, index) => date !== parsed[index])) {
    throw new Error(`${label} must contain unique dates in ascending order.`);
  }
  return parsed;
}

export function parseSyncFieldClock(
  value: unknown,
  options: ClockValidationOptions = {},
  label = 'Sync field clock',
): FieldClock {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, ['at', 'deviceId'], label);
  return {
    at: canonicalTimestamp(value.at, `${label}.at`, options),
    deviceId: requiredString(value.deviceId, `${label}.deviceId`),
  };
}

function parseFieldClockMap<Field extends string>(
  value: unknown,
  fields: readonly Field[],
  label: string,
  options: ClockValidationOptions,
): FieldClockMap<Field> {
  if (!isObject(value)) throw new Error(`${label} must be an object.`);
  assertExactKeys(value, fields, label);
  return Object.fromEntries(
    fields.map(field => [field, parseSyncFieldClock(value[field], options, `${label}.${field}`)]),
  ) as FieldClockMap<Field>;
}

function assertLatestBusinessClock(
  updatedAt: string,
  fieldUpdatedAt: FieldClockMap<string>,
  label: string,
): void {
  const latest = Object.values(fieldUpdatedAt).reduce(
    (current, clock) => (clock.at > current ? clock.at : current),
    '',
  );
  if (updatedAt !== latest) throw new Error(`${label}.updatedAt must match its latest business-field clock.`);
}

function parseCategoryRecord(
  value: Record<string, unknown>,
  options: ClockValidationOptions,
  remote: false,
): CategorySyncRecord;
function parseCategoryRecord(
  value: Record<string, unknown>,
  options: RemoteRecordValidationOptions,
  remote: true,
): RemoteCategorySyncRecord;
function parseCategoryRecord(
  value: Record<string, unknown>,
  options: ClockValidationOptions | RemoteRecordValidationOptions,
  remote: boolean,
): CategorySyncRecord | RemoteCategorySyncRecord {
  assertExactKeys(value, remote ? [...CATEGORY_KEYS, ...REMOTE_IDENTITY_KEYS] : CATEGORY_KEYS, 'Category sync record');
  const updatedAt = canonicalTimestamp(value.updatedAt, 'Category sync record.updatedAt', options);
  const fieldUpdatedAt = parseFieldClockMap<CategorySyncField>(
    value.fieldUpdatedAt,
    CATEGORY_SYNC_FIELDS,
    'Category sync record.fieldUpdatedAt',
    options,
  );
  assertLatestBusinessClock(updatedAt, fieldUpdatedAt, 'Category sync record');
  const record: CategorySyncRecord = {
    recordType: 'category',
    id: requiredString(value.id, 'Category sync record.id'),
    name: requiredString(value.name, 'Category sync record.name'),
    sortKey: requiredString(value.sortKey, 'Category sync record.sortKey'),
    updatedAt,
    version: remote
      ? positiveInteger(value.version, 'Category sync record.version')
      : nonnegativeInteger(value.version, 'Category sync record.version'),
    deletedAt: nullableTimestamp(value.deletedAt, 'Category sync record.deletedAt', options),
    updatedByDeviceId: requiredString(value.updatedByDeviceId, 'Category sync record.updatedByDeviceId'),
    fieldUpdatedAt,
    changeSeq: remote
      ? positiveInteger(value.changeSeq, 'Category sync record.changeSeq')
      : nonnegativeInteger(value.changeSeq, 'Category sync record.changeSeq'),
  };
  return remote ? { ...record, ...parseRemoteIdentity(value, options as RemoteRecordValidationOptions) } : record;
}

function parseTaskRecord(
  value: Record<string, unknown>,
  options: ClockValidationOptions,
  remote: false,
): TaskSyncRecord;
function parseTaskRecord(
  value: Record<string, unknown>,
  options: RemoteRecordValidationOptions,
  remote: true,
): RemoteTaskSyncRecord;
function parseTaskRecord(
  value: Record<string, unknown>,
  options: ClockValidationOptions | RemoteRecordValidationOptions,
  remote: boolean,
): TaskSyncRecord | RemoteTaskSyncRecord {
  assertExactKeys(value, remote ? [...TASK_KEYS, ...REMOTE_IDENTITY_KEYS] : TASK_KEYS, 'Task sync record');
  const updatedAt = canonicalTimestamp(value.updatedAt, 'Task sync record.updatedAt', options);
  const fieldUpdatedAt = parseFieldClockMap<TaskSyncField>(
    value.fieldUpdatedAt,
    TASK_SYNC_FIELDS,
    'Task sync record.fieldUpdatedAt',
    options,
  );
  assertLatestBusinessClock(updatedAt, fieldUpdatedAt, 'Task sync record');
  const record: TaskSyncRecord = {
    recordType: 'task',
    id: requiredString(value.id, 'Task sync record.id'),
    categoryId: requiredString(value.categoryId, 'Task sync record.categoryId'),
    title: requiredString(value.title, 'Task sync record.title'),
    scheduledDates: scheduledDates(value.scheduledDates, 'Task sync record.scheduledDates'),
    deadlineDate: nullableCalendarDate(value.deadlineDate, 'Task sync record.deadlineDate'),
    sortKey: requiredString(value.sortKey, 'Task sync record.sortKey'),
    updatedAt,
    version: remote
      ? positiveInteger(value.version, 'Task sync record.version')
      : nonnegativeInteger(value.version, 'Task sync record.version'),
    deletedAt: nullableTimestamp(value.deletedAt, 'Task sync record.deletedAt', options),
    updatedByDeviceId: requiredString(value.updatedByDeviceId, 'Task sync record.updatedByDeviceId'),
    fieldUpdatedAt,
    changeSeq: remote
      ? positiveInteger(value.changeSeq, 'Task sync record.changeSeq')
      : nonnegativeInteger(value.changeSeq, 'Task sync record.changeSeq'),
  };
  return remote ? { ...record, ...parseRemoteIdentity(value, options as RemoteRecordValidationOptions) } : record;
}

function parseRemoteIdentity(
  value: Record<string, unknown>,
  options: RemoteRecordValidationOptions,
): RemoteRecordIdentity {
  const notebookId = requiredString(value.notebookId, 'Remote sync record.notebookId');
  const ownerId = requiredString(value.ownerId, 'Remote sync record.ownerId');
  if (notebookId !== options.expectedNotebookId) throw new Error('Remote sync record belongs to the wrong notebook.');
  if (ownerId !== options.expectedOwnerId) throw new Error('Remote sync record belongs to the wrong account.');
  return { notebookId, ownerId };
}

function requireKnownRecordType(value: Record<string, unknown>, label: string): 'category' | 'task' {
  if (value.recordType !== 'category' && value.recordType !== 'task') {
    throw new Error(`${label} has an unknown record type.`);
  }
  return value.recordType;
}

export function parseLocalSyncRecord(value: unknown, options: ClockValidationOptions = {}): LocalSyncRecord {
  if (!isObject(value)) throw new Error('Local sync record must be an object.');
  return requireKnownRecordType(value, 'Local sync record') === 'category'
    ? parseCategoryRecord(value, options, false)
    : parseTaskRecord(value, options, false);
}

export function parseRemoteSyncRecord(
  value: unknown,
  options: RemoteRecordValidationOptions,
): RemoteSyncRecord {
  if (!isObject(value)) throw new Error('Remote sync record must be an object.');
  return requireKnownRecordType(value, 'Remote sync record') === 'category'
    ? parseCategoryRecord(value, options, true)
    : parseTaskRecord(value, options, true);
}

export function parseRecordMutation(
  value: unknown,
  options: RemoteRecordValidationOptions,
): RecordMutation {
  if (!isObject(value)) throw new Error('Record mutation must be an object.');
  assertExactKeys(
    value,
    ['mutationId', 'recordType', 'notebookId', 'ownerId', 'expectedVersion', 'queuedAt', 'record'],
    'Record mutation',
  );
  const recordType = requireKnownRecordType(value, 'Record mutation');
  const identity = parseRemoteIdentity(value, options);
  const expectedVersion = nonnegativeInteger(value.expectedVersion, 'Record mutation.expectedVersion');
  const record = parseLocalSyncRecord(value.record, options);
  if (record.recordType !== recordType) throw new Error('Record mutation type does not match its record.');
  if (record.version !== expectedVersion) throw new Error('Record mutation expected version does not match its base version.');
  const envelope = {
    mutationId: requiredString(value.mutationId, 'Record mutation.mutationId'),
    ...identity,
    expectedVersion,
    queuedAt: canonicalTimestamp(value.queuedAt, 'Record mutation.queuedAt', options),
  };
  return recordType === 'category'
    ? { ...envelope, recordType, record: record as CategorySyncRecord }
    : { ...envelope, recordType, record: record as TaskSyncRecord };
}

export function parseMutationAcknowledgement(
  value: unknown,
  options: RemoteRecordValidationOptions,
): MutationAcknowledgement {
  if (!isObject(value)) throw new Error('Mutation acknowledgement must be an object.');
  assertExactKeys(value, ['mutationId', 'outcome', 'recordType', 'record'], 'Mutation acknowledgement');
  const recordType = requireKnownRecordType(value, 'Mutation acknowledgement');
  if (value.outcome !== 'accepted' && value.outcome !== 'stale') {
    throw new Error('Mutation acknowledgement has an unknown outcome.');
  }
  const outcome: 'accepted' | 'stale' = value.outcome;
  const record = parseRemoteSyncRecord(value.record, options);
  if (record.recordType !== recordType) throw new Error('Mutation acknowledgement type does not match its record.');
  const envelope = {
    mutationId: requiredString(value.mutationId, 'Mutation acknowledgement.mutationId'),
    outcome,
  };
  return recordType === 'category'
    ? { ...envelope, recordType, record: record as RemoteCategorySyncRecord }
    : { ...envelope, recordType, record: record as RemoteTaskSyncRecord };
}

export function parseChangeCursor(value: unknown): ChangeCursor {
  if (!isObject(value)) throw new Error('Change cursor must be an object.');
  assertExactKeys(value, ['lastChangeSeq'], 'Change cursor');
  return { lastChangeSeq: nonnegativeInteger(value.lastChangeSeq, 'Change cursor.lastChangeSeq') };
}

const RECORD_SYNC_STATUSES: readonly RecordSyncStatus[] = [
  'disabled',
  'disconnected',
  'catching-up',
  'live',
  'degraded',
  'paused',
  'error',
];

export function parseRecordSyncState(
  value: unknown,
  options: RecordSyncStateValidationOptions = {},
): RecordSyncState {
  if (!isObject(value)) throw new Error('Record sync state must be an object.');
  assertExactKeys(
    value,
    ['schemaVersion', 'deviceId', 'accountId', 'projectRef', 'notebookId', 'lastChangeSeq', 'status', 'lastError'],
    'Record sync state',
  );
  if (value.schemaVersion !== RECORD_SYNC_STATE_VERSION) {
    throw new Error('Record sync state uses an unsupported schema version.');
  }
  const accountId = nullableString(value.accountId, 'Record sync state.accountId');
  const projectRef = nullableString(value.projectRef, 'Record sync state.projectRef');
  const notebookId = nullableString(value.notebookId, 'Record sync state.notebookId');
  if ((accountId === null) !== (projectRef === null)) {
    throw new Error('Record sync state has an incomplete account/project binding.');
  }
  if (notebookId !== null && accountId === null) {
    throw new Error('Record sync state cannot bind a notebook without an account.');
  }
  if (options.expectedAccountId !== undefined && accountId !== options.expectedAccountId) {
    throw new Error('Record sync state belongs to the wrong account.');
  }
  if (options.expectedProjectRef !== undefined && projectRef !== options.expectedProjectRef) {
    throw new Error('Record sync state belongs to the wrong project.');
  }
  if (options.expectedNotebookId !== undefined && notebookId !== options.expectedNotebookId) {
    throw new Error('Record sync state belongs to the wrong notebook.');
  }
  if (!RECORD_SYNC_STATUSES.includes(value.status as RecordSyncStatus)) {
    throw new Error('Record sync state has an unknown status.');
  }
  return {
    schemaVersion: RECORD_SYNC_STATE_VERSION,
    deviceId: requiredString(value.deviceId, 'Record sync state.deviceId'),
    accountId,
    projectRef,
    notebookId,
    lastChangeSeq: nonnegativeInteger(value.lastChangeSeq, 'Record sync state.lastChangeSeq'),
    status: value.status as RecordSyncStatus,
    lastError: nullableString(value.lastError, 'Record sync state.lastError'),
  };
}
