import {
  CATEGORY_SYNC_FIELDS,
  TASK_SYNC_FIELDS,
  type CategorySyncField,
  type CategorySyncRecord,
  type FieldClock,
  type LocalSyncRecord,
  type TaskSyncField,
  type TaskSyncRecord,
} from './types.ts';
import { parseSyncFieldClock, type ClockValidationOptions } from './validation.ts';

export type SyncBusinessField = CategorySyncField | TaskSyncField;
export type ReconciledField = SyncBusinessField | 'deletedAt';
export type ReconciliationAction = 'noop' | 'apply-server' | 'upload-local' | 'upload-merged';

export interface RecordReconciliation {
  action: ReconciliationAction;
  /** Local row to save after this reconciliation. */
  record: LocalSyncRecord;
  /** Latest acknowledged server row to retain as the three-way merge base. */
  base: LocalSyncRecord | null;
  /** Version the next OCC mutation must match. */
  expectedVersion: number;
  /** Business/tombstone fields that differ from the acknowledged server row. */
  uploadFields: ReconciledField[];
}

function fieldClocks(record: LocalSyncRecord): Record<string, FieldClock> {
  return record.fieldUpdatedAt as Record<string, FieldClock>;
}

function businessFields(record: LocalSyncRecord): readonly SyncBusinessField[] {
  return record.recordType === 'category' ? CATEGORY_SYNC_FIELDS : TASK_SYNC_FIELDS;
}

function businessValue(record: LocalSyncRecord, field: SyncBusinessField): unknown {
  return (record as unknown as Record<string, unknown>)[field];
}

function valuesEqual(first: unknown, second: unknown): boolean {
  if (Array.isArray(first) || Array.isArray(second)) {
    return Array.isArray(first)
      && Array.isArray(second)
      && first.length === second.length
      && first.every((value, index) => value === second[index]);
  }
  return first === second;
}

function clocksEqual(first: FieldClock, second: FieldClock): boolean {
  return first.at === second.at && first.deviceId === second.deviceId;
}

function cloneClock(clock: FieldClock): FieldClock {
  return { at: clock.at, deviceId: clock.deviceId };
}

function cloneCategory(record: CategorySyncRecord): CategorySyncRecord {
  return {
    recordType: 'category',
    id: record.id,
    name: record.name,
    sortKey: record.sortKey,
    updatedAt: record.updatedAt,
    version: record.version,
    deletedAt: record.deletedAt,
    updatedByDeviceId: record.updatedByDeviceId,
    fieldUpdatedAt: {
      name: cloneClock(record.fieldUpdatedAt.name),
      sortKey: cloneClock(record.fieldUpdatedAt.sortKey),
    },
    changeSeq: record.changeSeq,
  };
}

function cloneTask(record: TaskSyncRecord): TaskSyncRecord {
  return {
    recordType: 'task',
    id: record.id,
    categoryId: record.categoryId,
    title: record.title,
    scheduledDates: [...record.scheduledDates],
    deadlineDate: record.deadlineDate,
    sortKey: record.sortKey,
    updatedAt: record.updatedAt,
    version: record.version,
    deletedAt: record.deletedAt,
    updatedByDeviceId: record.updatedByDeviceId,
    fieldUpdatedAt: {
      categoryId: cloneClock(record.fieldUpdatedAt.categoryId),
      title: cloneClock(record.fieldUpdatedAt.title),
      scheduledDates: cloneClock(record.fieldUpdatedAt.scheduledDates),
      deadlineDate: cloneClock(record.fieldUpdatedAt.deadlineDate),
      sortKey: cloneClock(record.fieldUpdatedAt.sortKey),
    },
    changeSeq: record.changeSeq,
  };
}

export function cloneSyncRecord(record: LocalSyncRecord): LocalSyncRecord {
  return record.recordType === 'category' ? cloneCategory(record) : cloneTask(record);
}

function assertCompatibleRecords(records: readonly (LocalSyncRecord | null)[]): void {
  const present = records.filter((record): record is LocalSyncRecord => record !== null);
  const first = present[0];
  if (!first) throw new Error('At least one sync record is required for reconciliation.');
  if (present.some(record => record.id !== first.id || record.recordType !== first.recordType)) {
    throw new Error('Cannot reconcile records with different identities or types.');
  }
}

function validateRecordClocks(
  records: readonly (LocalSyncRecord | null)[],
  options: ClockValidationOptions,
): void {
  for (const record of records) {
    if (!record) continue;
    for (const field of businessFields(record)) {
      parseSyncFieldClock(fieldClocks(record)[field], options, `${record.recordType}.${field} clock`);
    }
    if (record.deletedAt !== null) {
      parseSyncFieldClock(
        { at: record.deletedAt, deviceId: record.updatedByDeviceId },
        options,
        `${record.recordType}.deletedAt clock`,
      );
    }
  }
}

export function compareFieldClocks(
  first: FieldClock,
  second: FieldClock,
  options: ClockValidationOptions = {},
): -1 | 0 | 1 {
  const validFirst = parseSyncFieldClock(first, options, 'First field clock');
  const validSecond = parseSyncFieldClock(second, options, 'Second field clock');
  if (validFirst.at < validSecond.at) return -1;
  if (validFirst.at > validSecond.at) return 1;
  if (validFirst.deviceId < validSecond.deviceId) return -1;
  if (validFirst.deviceId > validSecond.deviceId) return 1;
  return 0;
}

function syncRecordEqual(first: LocalSyncRecord, second: LocalSyncRecord): boolean {
  if (
    first.recordType !== second.recordType
    || first.id !== second.id
    || first.version !== second.version
    || first.changeSeq !== second.changeSeq
    || first.updatedAt !== second.updatedAt
    || first.deletedAt !== second.deletedAt
    || first.updatedByDeviceId !== second.updatedByDeviceId
  ) return false;
  return businessFields(first).every(field => (
    valuesEqual(businessValue(first, field), businessValue(second, field))
    && clocksEqual(fieldClocks(first)[field], fieldClocks(second)[field])
  ));
}

function compareCanonicalProgress(current: LocalSyncRecord, incoming: LocalSyncRecord): -1 | 0 | 1 {
  if (incoming.version < current.version) {
    if (incoming.changeSeq >= current.changeSeq) {
      throw new Error('An older record version cannot have a newer change sequence.');
    }
    return -1;
  }
  if (incoming.version > current.version) {
    if (incoming.changeSeq <= current.changeSeq) {
      throw new Error('A newer record version must have a newer change sequence.');
    }
    return 1;
  }
  if (incoming.changeSeq !== current.changeSeq || !syncRecordEqual(current, incoming)) {
    throw new Error('Canonical rows with the same version must be identical.');
  }
  return 0;
}

/**
 * Apply a validated canonical row without rolling a record backward. Exact
 * duplicates and older out-of-order events return the existing object.
 */
export function applyServerRecord(
  current: LocalSyncRecord | null,
  incoming: LocalSyncRecord,
): LocalSyncRecord {
  if (!current) return cloneSyncRecord(incoming);
  assertCompatibleRecords([current, incoming]);
  return compareCanonicalProgress(current, incoming) > 0 ? cloneSyncRecord(incoming) : current;
}

function changedBusinessFields(
  base: LocalSyncRecord | null,
  record: LocalSyncRecord,
): Set<ReconciledField> {
  const changed = new Set<ReconciledField>();
  for (const field of businessFields(record)) {
    if (
      !base
      || !valuesEqual(businessValue(base, field), businessValue(record, field))
      || !clocksEqual(fieldClocks(base)[field], fieldClocks(record)[field])
    ) changed.add(field);
  }
  if (
    base
      ? base.deletedAt !== record.deletedAt
        || (record.deletedAt !== null && base.updatedByDeviceId !== record.updatedByDeviceId)
      : record.deletedAt !== null
  ) changed.add('deletedAt');
  return changed;
}

function setBusinessField(
  record: LocalSyncRecord,
  field: SyncBusinessField,
  value: unknown,
  clock: FieldClock,
): void {
  (record as unknown as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
  fieldClocks(record)[field] = cloneClock(clock);
}

function latestBusinessClock(record: LocalSyncRecord, options: ClockValidationOptions): FieldClock {
  const clocks = businessFields(record).map(field => fieldClocks(record)[field]);
  return clocks.reduce((latest, clock) => (
    compareFieldClocks(clock, latest, options) > 0 ? clock : latest
  ));
}

interface DeletionCandidate {
  record: LocalSyncRecord;
  clock: FieldClock;
}

function winningDeletion(
  records: readonly (LocalSyncRecord | null)[],
  options: ClockValidationOptions,
): DeletionCandidate | null {
  const candidates = records
    .filter((record): record is LocalSyncRecord => record !== null && record.deletedAt !== null)
    .map(record => ({
      record,
      clock: parseSyncFieldClock(
        { at: record.deletedAt!, deviceId: record.updatedByDeviceId },
        options,
        'Record deletion clock',
      ),
    }));
  return candidates.reduce<DeletionCandidate | null>((winner, candidate) => {
    if (!winner || compareFieldClocks(candidate.clock, winner.clock, options) > 0) return candidate;
    return winner;
  }, null);
}

function uploadDifferences(
  record: LocalSyncRecord,
  server: LocalSyncRecord | null,
): ReconciledField[] {
  const differences: ReconciledField[] = [];
  for (const field of businessFields(record)) {
    if (
      !server
      || !valuesEqual(businessValue(record, field), businessValue(server, field))
      || !clocksEqual(fieldClocks(record)[field], fieldClocks(server)[field])
    ) differences.push(field);
  }
  if (
    !server
    || record.deletedAt !== server.deletedAt
    || (record.deletedAt !== null && record.updatedByDeviceId !== server.updatedByDeviceId)
  ) differences.push('deletedAt');
  return differences;
}

function mergedRecord(
  local: LocalSyncRecord,
  server: LocalSyncRecord,
  localChanges: Set<ReconciledField>,
  serverChanges: Set<ReconciledField>,
  options: ClockValidationOptions,
): LocalSyncRecord {
  const merged = cloneSyncRecord(server);
  for (const field of businessFields(merged)) {
    const localChanged = localChanges.has(field);
    const serverChanged = serverChanges.has(field);
    if (localChanged && !serverChanged) {
      setBusinessField(merged, field, businessValue(local, field), fieldClocks(local)[field]);
    } else if (localChanged && serverChanged) {
      const winner = compareFieldClocks(fieldClocks(local)[field], fieldClocks(server)[field], options) > 0
        ? local
        : server;
      setBusinessField(merged, field, businessValue(winner, field), fieldClocks(winner)[field]);
    }
  }

  merged.deletedAt = null;
  const latestClock = latestBusinessClock(merged, options);
  merged.updatedAt = latestClock.at;
  merged.updatedByDeviceId = latestClock.deviceId;
  merged.version = server.version;
  merged.changeSeq = server.changeSeq;
  return merged;
}

/**
 * Reconcile one local row against its last acknowledged base and the newest
 * server row. Inputs are never mutated and provider identity fields are never
 * copied into the returned local record.
 */
export function reconcileRecord(
  base: LocalSyncRecord | null,
  local: LocalSyncRecord | null,
  server: LocalSyncRecord | null,
  options: ClockValidationOptions = {},
): RecordReconciliation {
  assertCompatibleRecords([base, local, server]);
  validateRecordClocks([base, local, server], options);
  if (base && !local) throw new Error('An acknowledged local row cannot disappear; use a tombstone.');

  const effectiveServer = server
    ? (base ? applyServerRecord(base, server) : cloneSyncRecord(server))
    : (base ? cloneSyncRecord(base) : null);

  if (!local) {
    if (!effectiveServer) throw new Error('Reconciliation has neither a local nor a server record.');
    return {
      action: 'apply-server',
      record: cloneSyncRecord(effectiveServer),
      base: cloneSyncRecord(effectiveServer),
      expectedVersion: effectiveServer.version,
      uploadFields: [],
    };
  }

  if (!effectiveServer) {
    const record = cloneSyncRecord(local);
    record.version = 0;
    record.changeSeq = 0;
    return {
      action: 'upload-local',
      record,
      base: null,
      expectedVersion: 0,
      uploadFields: uploadDifferences(record, null),
    };
  }

  const localChanges = changedBusinessFields(base, local);
  const serverChanges = changedBusinessFields(base, effectiveServer);
  let record: LocalSyncRecord;
  const deletion = winningDeletion([effectiveServer, local, base], options);
  if (deletion) {
    // The winning tombstone's entire row wins over edits on an active copy.
    record = cloneSyncRecord(deletion.record);
    record.version = effectiveServer.version;
    record.changeSeq = effectiveServer.changeSeq;
  } else if (localChanges.size === 0) {
    record = cloneSyncRecord(effectiveServer);
  } else if (serverChanges.size === 0) {
    record = cloneSyncRecord(local);
    record.version = effectiveServer.version;
    record.changeSeq = effectiveServer.changeSeq;
  } else {
    record = mergedRecord(local, effectiveServer, localChanges, serverChanges, options);
  }
  const uploadFields = uploadDifferences(record, effectiveServer);
  const needsUpload = uploadFields.length > 0;
  const action: ReconciliationAction = needsUpload
    ? (serverChanges.size === 0 ? 'upload-local' : 'upload-merged')
    : (syncRecordEqual(local, record) ? 'noop' : 'apply-server');
  return {
    action,
    record,
    base: cloneSyncRecord(effectiveServer),
    expectedVersion: effectiveServer.version,
    uploadFields,
  };
}

/**
 * Convert active children of a deleted category into deterministic tombstones.
 * Reapplying it to the result yields no further work.
 */
export function cascadeCategoryTombstones(
  category: CategorySyncRecord,
  tasks: readonly TaskSyncRecord[],
): TaskSyncRecord[] {
  if (!category.deletedAt) return [];
  return tasks
    .filter(task => task.categoryId === category.id && task.deletedAt === null)
    .sort((first, second) => first.id < second.id ? -1 : first.id > second.id ? 1 : 0)
    .map(task => ({
      ...cloneTask(task),
      deletedAt: category.deletedAt,
      updatedByDeviceId: category.updatedByDeviceId,
    }));
}
