import { normalizeDates } from '../dates.ts';
import type { StoredDocument } from '../storage.ts';
import { parseStoredText } from '../storage.ts';
import {
  CATEGORY_SYNC_FIELDS,
  RECORD_SYNC_STATE_VERSION,
  TASK_SYNC_FIELDS,
  applyServerRecord as applyCanonicalServerRecord,
  cascadeCategoryTombstones,
  cloneSyncRecord,
  compareBySortKeyThenId,
  generateEvenSortKeys,
  parseLocalSyncRecord,
  parseRecordSyncState,
  parseSyncFieldClock,
  type CategorySyncRecord,
  type FieldClock,
  type LocalSyncRecord,
  type MutationAcknowledgement,
  type RecordReconciliation,
  type RecordSyncState,
  type SyncRecordType,
  type TaskSyncField,
  type TaskSyncRecord,
} from '../sync-v2/index.ts';
import {
  LOCAL_REPOSITORY_SCHEMA_VERSION,
  MAX_LOCAL_RECOVERY_BACKUPS,
  type AcknowledgementResult,
  type CreateCategoryInput,
  type CreateTaskInput,
  type EditCategoryInput,
  type EditTaskInput,
  type LegacyImportResult,
  type LocalOutboxEntry,
  type LocalPreferences,
  type LocalReadModel,
  type LocalRecoveryBackup,
  type LocalRepository,
  type LocalRepositoryDependencies,
  type LocalRepositorySnapshot,
  type LocalRepositoryTransaction,
  type LocalStateStore,
  type OutboxAttemptInput,
  type ReorderRecordsInput,
  type SoftDeleteInput,
} from './types.ts';

const DEFAULT_PREFERENCES: LocalPreferences = {
  viewMode: 'all',
  theme: 'dark',
  colorTheme: 'neutral',
};

const SNAPSHOT_KEYS = [
  'schemaVersion',
  'categories',
  'tasks',
  'bases',
  'outbox',
  'syncState',
  'preferences',
  'recoveryBackups',
  'legacyImportComplete',
  'legacyImportedAt',
] as const;

function cloneValue<Value>(value: Value): Value {
  return JSON.parse(JSON.stringify(value)) as Value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find(key => !allowed.has(key));
  if (unexpected) throw new Error(`${label} has an unsupported ${unexpected} field.`);
  const missing = keys.find(key => !Object.hasOwn(value, key));
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

function canonicalTimestamp(value: unknown, label: string, now: number): string {
  return parseSyncFieldClock({ at: value, deviceId: 'local-repository-validation' }, { now }, label).at;
}

function parsePreferences(value: unknown): LocalPreferences {
  if (!isObject(value)) throw new Error('Local preferences must be an object.');
  assertExactKeys(value, ['viewMode', 'theme', 'colorTheme'], 'Local preferences');
  if (value.viewMode !== 'all' && value.viewMode !== 'today' && value.viewMode !== 'tomorrow') {
    throw new Error('Local preferences have an invalid view mode.');
  }
  if (value.theme !== 'dark' && value.theme !== 'light') {
    throw new Error('Local preferences have an invalid theme.');
  }
  if (
    value.colorTheme !== 'neutral'
    && value.colorTheme !== 'violet'
    && value.colorTheme !== 'ocean'
    && value.colorTheme !== 'forest'
    && value.colorTheme !== 'rose'
  ) throw new Error('Local preferences have an invalid color theme.');
  return {
    viewMode: value.viewMode,
    theme: value.theme,
    colorTheme: value.colorTheme,
  };
}

function parseOutboxEntry(value: unknown, now: number): LocalOutboxEntry {
  if (!isObject(value)) throw new Error('Local outbox entry must be an object.');
  assertExactKeys(
    value,
    [
      'recordType', 'recordId', 'accountId', 'projectRef', 'notebookId', 'mutationId',
      'expectedVersion', 'record', 'attemptCount', 'lastAttemptAt', 'lastError', 'createdAt', 'updatedAt',
    ],
    'Local outbox entry',
  );
  if (value.recordType !== 'category' && value.recordType !== 'task') {
    throw new Error('Local outbox entry has an unknown record type.');
  }
  const record = parseLocalSyncRecord(value.record, { now });
  const recordId = requiredString(value.recordId, 'Local outbox entry.recordId');
  const expectedVersion = nonnegativeInteger(value.expectedVersion, 'Local outbox entry.expectedVersion');
  if (record.recordType !== value.recordType || record.id !== recordId) {
    throw new Error('Local outbox entry identity does not match its record.');
  }
  if (record.version !== expectedVersion) {
    throw new Error('Local outbox entry expected version does not match its record.');
  }
  const createdAt = canonicalTimestamp(value.createdAt, 'Local outbox entry.createdAt', now);
  const updatedAt = canonicalTimestamp(value.updatedAt, 'Local outbox entry.updatedAt', now);
  if (updatedAt < createdAt) throw new Error('Local outbox entry was updated before it was created.');
  return {
    recordType: value.recordType,
    recordId,
    accountId: requiredString(value.accountId, 'Local outbox entry.accountId'),
    projectRef: requiredString(value.projectRef, 'Local outbox entry.projectRef'),
    notebookId: requiredString(value.notebookId, 'Local outbox entry.notebookId'),
    mutationId: requiredString(value.mutationId, 'Local outbox entry.mutationId'),
    expectedVersion,
    record,
    attemptCount: nonnegativeInteger(value.attemptCount, 'Local outbox entry.attemptCount'),
    lastAttemptAt: value.lastAttemptAt === null
      ? null
      : canonicalTimestamp(value.lastAttemptAt, 'Local outbox entry.lastAttemptAt', now),
    lastError: nullableString(value.lastError, 'Local outbox entry.lastError'),
    createdAt,
    updatedAt,
  };
}

function parseRecoveryBackup(value: unknown, now: number): LocalRecoveryBackup {
  if (!isObject(value)) throw new Error('Local recovery backup must be an object.');
  assertExactKeys(value, ['backupId', 'createdAt', 'reason', 'documentJson'], 'Local recovery backup');
  const documentJson = requiredString(value.documentJson, 'Local recovery backup.documentJson');
  parseStoredText(documentJson);
  return {
    backupId: requiredString(value.backupId, 'Local recovery backup.backupId'),
    createdAt: canonicalTimestamp(value.createdAt, 'Local recovery backup.createdAt', now),
    reason: requiredString(value.reason, 'Local recovery backup.reason'),
    documentJson,
  };
}

function recordKey(recordType: SyncRecordType, recordId: string): string {
  return `${recordType}:${recordId}`;
}

function outboxKey(entry: Pick<LocalOutboxEntry, 'accountId' | 'projectRef' | 'notebookId' | 'recordType' | 'recordId'>): string {
  return `${entry.accountId}:${entry.projectRef}:${entry.notebookId}:${recordKey(entry.recordType, entry.recordId)}`;
}

function recordsEqual(first: LocalSyncRecord, second: LocalSyncRecord): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function parseLocalRepositorySnapshot(
  value: unknown,
  options: { now?: number } = {},
): LocalRepositorySnapshot {
  if (!isObject(value)) throw new Error('Local repository snapshot must be an object.');
  assertExactKeys(value, SNAPSHOT_KEYS, 'Local repository snapshot');
  if (value.schemaVersion !== LOCAL_REPOSITORY_SCHEMA_VERSION) {
    throw new Error('Local repository snapshot uses an unsupported schema version.');
  }
  if (!Array.isArray(value.categories) || !Array.isArray(value.tasks) || !Array.isArray(value.bases)) {
    throw new Error('Local repository snapshot has invalid record collections.');
  }
  if (!Array.isArray(value.outbox) || !Array.isArray(value.recoveryBackups)) {
    throw new Error('Local repository snapshot has invalid durable metadata collections.');
  }
  const now = options.now ?? Date.now();
  const categories = value.categories.map(item => parseLocalSyncRecord(item, { now })).map(record => {
    if (record.recordType !== 'category') throw new Error('Local category table contains a task.');
    return record;
  });
  const tasks = value.tasks.map(item => parseLocalSyncRecord(item, { now })).map(record => {
    if (record.recordType !== 'task') throw new Error('Local task table contains a category.');
    return record;
  });
  const bases = value.bases.map(item => parseLocalSyncRecord(item, { now }));
  const outbox = value.outbox.map(item => parseOutboxEntry(item, now));
  const recoveryBackups = value.recoveryBackups.map(item => parseRecoveryBackup(item, now));
  const categoryIds = new Set<string>();
  for (const category of categories) {
    if (categoryIds.has(category.id)) throw new Error('Local repository has duplicate category IDs.');
    categoryIds.add(category.id);
  }
  const taskIds = new Set<string>();
  for (const task of tasks) {
    if (taskIds.has(task.id)) throw new Error('Local repository has duplicate task IDs.');
    if (!categoryIds.has(task.categoryId)) throw new Error('A local task references a missing category.');
    taskIds.add(task.id);
  }
  const localKeys = new Set<string>([
    ...categories.map(record => recordKey(record.recordType, record.id)),
    ...tasks.map(record => recordKey(record.recordType, record.id)),
  ]);
  const baseKeys = new Set<string>();
  for (const base of bases) {
    const key = recordKey(base.recordType, base.id);
    if (baseKeys.has(key)) throw new Error('Local repository has duplicate base rows.');
    if (!localKeys.has(key)) throw new Error('A local base row has no matching local record.');
    baseKeys.add(key);
  }
  const outboxKeys = new Set<string>();
  const mutationIds = new Set<string>();
  for (const entry of outbox) {
    const key = outboxKey(entry);
    if (outboxKeys.has(key)) throw new Error('Local repository has duplicate outbox rows.');
    if (mutationIds.has(entry.mutationId)) throw new Error('Local repository has duplicate mutation IDs.');
    if (!localKeys.has(recordKey(entry.recordType, entry.recordId))) {
      throw new Error('A local outbox row has no matching local record.');
    }
    outboxKeys.add(key);
    mutationIds.add(entry.mutationId);
  }
  if (recoveryBackups.length > MAX_LOCAL_RECOVERY_BACKUPS) {
    throw new Error('Local repository has too many recovery backups.');
  }
  const backupIds = new Set<string>();
  for (const backup of recoveryBackups) {
    if (backupIds.has(backup.backupId)) throw new Error('Local repository has duplicate recovery backup IDs.');
    backupIds.add(backup.backupId);
  }
  const syncState = parseRecordSyncState(value.syncState);
  const legacyImportComplete = value.legacyImportComplete;
  if (typeof legacyImportComplete !== 'boolean') {
    throw new Error('Local repository has an invalid legacy import marker.');
  }
  const legacyImportedAt = value.legacyImportedAt === null
    ? null
    : canonicalTimestamp(value.legacyImportedAt, 'Local repository legacyImportedAt', now);
  if (!legacyImportComplete && legacyImportedAt !== null) {
    throw new Error('An incomplete legacy import cannot have a completion time.');
  }
  return {
    schemaVersion: LOCAL_REPOSITORY_SCHEMA_VERSION,
    categories,
    tasks,
    bases,
    outbox,
    syncState,
    preferences: parsePreferences(value.preferences),
    recoveryBackups,
    legacyImportComplete,
    legacyImportedAt,
  };
}

function defaultSnapshot(deviceId: string): LocalRepositorySnapshot {
  return {
    schemaVersion: LOCAL_REPOSITORY_SCHEMA_VERSION,
    categories: [],
    tasks: [],
    bases: [],
    outbox: [],
    syncState: {
      schemaVersion: RECORD_SYNC_STATE_VERSION,
      deviceId,
      accountId: null,
      projectRef: null,
      notebookId: null,
      lastChangeSeq: 0,
      status: 'disabled',
      lastError: null,
    },
    preferences: cloneValue(DEFAULT_PREFERENCES),
    recoveryBackups: [],
    legacyImportComplete: false,
    legacyImportedAt: null,
  };
}

function defaultId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function clock(at: string, deviceId: string, now: number): FieldClock {
  return parseSyncFieldClock({ at, deviceId }, { now }, 'Local edit clock');
}

function newestBusinessClock(record: LocalSyncRecord): FieldClock {
  const clocks: FieldClock[] = record.recordType === 'category'
    ? CATEGORY_SYNC_FIELDS.map(field => record.fieldUpdatedAt[field])
    : TASK_SYNC_FIELDS.map(field => record.fieldUpdatedAt[field]);
  return clocks.reduce((newest, candidate) => {
    if (candidate.at !== newest.at) return candidate.at > newest.at ? candidate : newest;
    return candidate.deviceId > newest.deviceId ? candidate : newest;
  });
}

function stripRemoteIdentity(acknowledgement: MutationAcknowledgement): LocalSyncRecord {
  const { notebookId: _notebookId, ownerId: _ownerId, ...record } = acknowledgement.record;
  return record;
}

export class InMemoryLocalStateStore implements LocalStateStore {
  private snapshot: LocalRepositorySnapshot | null;
  failNextSave = false;
  saveCount = 0;

  constructor(initial: LocalRepositorySnapshot | null = null) {
    this.snapshot = initial === null ? null : cloneValue(initial);
  }

  async load(): Promise<LocalRepositorySnapshot | null> {
    return this.snapshot === null ? null : cloneValue(this.snapshot);
  }

  async save(snapshot: LocalRepositorySnapshot): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error('Injected local store failure.');
    }
    this.snapshot = cloneValue(snapshot);
    this.saveCount += 1;
  }

  inspect(): LocalRepositorySnapshot | null {
    return this.snapshot === null ? null : cloneValue(this.snapshot);
  }
}

export class TransactionalLocalRepository implements LocalRepository {
  private readonly store: LocalStateStore;
  private readonly now: () => string;
  private readonly createId: () => string;
  private state: LocalRepositorySnapshot | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    store: LocalStateStore,
    dependencies: LocalRepositoryDependencies = {},
  ) {
    this.store = store;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? defaultId;
  }

  private validationNow(): number {
    const now = Date.parse(this.now());
    if (!Number.isFinite(now)) throw new Error('The local repository clock returned an invalid timestamp.');
    return now;
  }

  private timestamp(): string {
    const value = this.now();
    return canonicalTimestamp(value, 'Local repository timestamp', Date.parse(value));
  }

  private async loadedState(): Promise<LocalRepositorySnapshot> {
    if (this.state) return this.state;
    const stored = await this.store.load();
    this.state = stored === null
      ? defaultSnapshot(this.createId())
      : parseLocalRepositorySnapshot(stored, { now: this.validationNow() });
    return this.state;
  }

  private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async initialize(legacyDocumentJson: string | null): Promise<LegacyImportResult> {
    return this.serialize(async () => {
      const current = await this.loadedState();
      if (current.legacyImportComplete) {
        return {
          imported: false,
          alreadyComplete: true,
          categoryCount: current.categories.length,
          taskCount: current.tasks.length,
          backupId: null,
        };
      }
      if (
        current.categories.length > 0
        || current.tasks.length > 0
        || current.bases.length > 0
        || current.outbox.length > 0
        || current.recoveryBackups.length > 0
      ) throw new Error('The interrupted legacy import left incomplete local data.');

      const draft = cloneValue(current);
      let backupId: string | null = null;
      let importedAt: string | null = null;
      if (legacyDocumentJson !== null) {
        const document = parseStoredText(legacyDocumentJson);
        this.assertUniqueLegacyTaskIds(document);
        importedAt = this.timestamp();
        const deviceId = draft.syncState.deviceId;
        const categorySortKeys = generateEvenSortKeys(document.categories.length);
        draft.categories = document.categories.map((category, categoryIndex) => {
          const editClock = clock(importedAt!, deviceId, this.validationNow());
          return {
            recordType: 'category',
            id: category.id,
            name: category.name,
            sortKey: categorySortKeys[categoryIndex],
            updatedAt: importedAt!,
            version: 0,
            deletedAt: null,
            updatedByDeviceId: deviceId,
            fieldUpdatedAt: { name: editClock, sortKey: editClock },
            changeSeq: 0,
          } satisfies CategorySyncRecord;
        });
        draft.tasks = document.categories.flatMap(category => {
          const taskSortKeys = generateEvenSortKeys(category.tasks.length);
          return category.tasks.map((task, taskIndex) => {
            const editClock = clock(importedAt!, deviceId, this.validationNow());
            return {
              recordType: 'task',
              id: task.id,
              categoryId: category.id,
              title: task.title,
              scheduledDates: [...task.scheduledDates],
              deadlineDate: task.deadlineDate,
              sortKey: taskSortKeys[taskIndex],
              updatedAt: importedAt!,
              version: 0,
              deletedAt: null,
              updatedByDeviceId: deviceId,
              fieldUpdatedAt: {
                categoryId: editClock,
                title: editClock,
                scheduledDates: editClock,
                deadlineDate: editClock,
                sortKey: editClock,
              },
              changeSeq: 0,
            } satisfies TaskSyncRecord;
          });
        });
        draft.preferences = cloneValue(document.preferences);
        backupId = this.createId();
        draft.recoveryBackups.push({
          backupId,
          createdAt: importedAt,
          reason: 'legacy-json-import',
          documentJson: legacyDocumentJson,
        });
      }
      draft.legacyImportComplete = true;
      draft.legacyImportedAt = importedAt;
      const committed = parseLocalRepositorySnapshot(draft, { now: this.validationNow() });
      await this.store.save(committed);
      this.state = committed;
      return {
        imported: legacyDocumentJson !== null,
        alreadyComplete: false,
        categoryCount: committed.categories.length,
        taskCount: committed.tasks.length,
        backupId,
      };
    });
  }

  private assertUniqueLegacyTaskIds(document: StoredDocument): void {
    const taskIds = new Set<string>();
    for (const category of document.categories) {
      for (const task of category.tasks) {
        if (taskIds.has(task.id)) throw new Error('Stored data has duplicate task ids across categories.');
        taskIds.add(task.id);
      }
    }
  }

  async readModel(): Promise<LocalReadModel> {
    return this.serialize(async () => {
      const state = await this.loadedState();
      const activeCategories = state.categories
        .filter(category => category.deletedAt === null)
        .sort(compareBySortKeyThenId);
      const activeCategoryIds = new Set(activeCategories.map(category => category.id));
      const tasksByCategory = new Map<string, TaskSyncRecord[]>();
      for (const task of state.tasks) {
        if (task.deletedAt !== null || !activeCategoryIds.has(task.categoryId)) continue;
        const tasks = tasksByCategory.get(task.categoryId) ?? [];
        tasks.push(task);
        tasksByCategory.set(task.categoryId, tasks);
      }
      return {
        notebook: {
          categories: activeCategories.map(category => ({
            id: category.id,
            name: category.name,
            tasks: (tasksByCategory.get(category.id) ?? [])
              .sort(compareBySortKeyThenId)
              .map(task => ({
                id: task.id,
                title: task.title,
                scheduledDates: [...task.scheduledDates],
                deadlineDate: task.deadlineDate,
              })),
            })),
        },
        records: {
          categories: cloneValue(state.categories),
          tasks: cloneValue(state.tasks),
        },
        preferences: cloneValue(state.preferences),
        syncState: cloneValue(state.syncState),
        legacyImportComplete: state.legacyImportComplete,
        legacyImportedAt: state.legacyImportedAt,
      };
    });
  }

  async transaction<Result>(
    work: (transaction: LocalRepositoryTransaction) => Result | Promise<Result>,
  ): Promise<Result> {
    return this.serialize(async () => {
      const current = await this.loadedState();
      const draft = cloneValue(current);
      const transaction = this.transactionFor(draft);
      const result = await work(transaction);
      const committed = parseLocalRepositorySnapshot(draft, { now: this.validationNow() });
      await this.store.save(committed);
      this.state = committed;
      return result;
    });
  }

  private transactionFor(draft: LocalRepositorySnapshot): LocalRepositoryTransaction {
    return {
      createCategory: input => this.createCategoryIn(draft, input),
      createTask: input => this.createTaskIn(draft, input),
      editCategory: (recordId, input) => this.editCategoryIn(draft, recordId, input),
      editTask: (recordId, input) => this.editTaskIn(draft, recordId, input),
      reorderRecords: input => this.reorderRecordsIn(draft, input),
      softDelete: input => this.softDeleteIn(draft, input),
      applyServerRecord: record => this.applyServerRecordIn(draft, record),
      applyReconciliation: reconciliation => this.applyReconciliationIn(draft, reconciliation),
      acknowledgeMutation: acknowledgement => this.acknowledgeMutationIn(draft, acknowledgement),
      getBase: (recordType, recordId) => this.getBaseIn(draft, recordType, recordId),
      listOutbox: () => this.listOutboxIn(draft),
      markOutboxAttempt: input => this.markOutboxAttemptIn(draft, input),
      setCursor: lastChangeSeq => this.setCursorIn(draft, lastChangeSeq),
      setSyncState: state => this.setSyncStateIn(draft, state),
      setPreferences: preferences => this.setPreferencesIn(draft, preferences),
      createRecoveryBackup: (documentJson, reason) => this.createRecoveryBackupIn(draft, documentJson, reason),
      listRecoveryBackups: () => this.listRecoveryBackupsIn(draft),
    };
  }

  private findRecord(
    draft: LocalRepositorySnapshot,
    recordType: SyncRecordType,
    recordId: string,
  ): LocalSyncRecord | undefined {
    return recordType === 'category'
      ? draft.categories.find(record => record.id === recordId)
      : draft.tasks.find(record => record.id === recordId);
  }

  private replaceRecord(draft: LocalRepositorySnapshot, record: LocalSyncRecord): void {
    const records = record.recordType === 'category' ? draft.categories : draft.tasks;
    const index = records.findIndex(item => item.id === record.id);
    if (index < 0) records.push(record as never);
    else records[index] = record as never;
  }

  private replaceBase(draft: LocalRepositorySnapshot, base: LocalSyncRecord | null, identity: LocalSyncRecord): void {
    const index = draft.bases.findIndex(item => item.recordType === identity.recordType && item.id === identity.id);
    if (base === null) {
      if (index >= 0) draft.bases.splice(index, 1);
    } else if (index < 0) draft.bases.push(cloneSyncRecord(base));
    else draft.bases[index] = cloneSyncRecord(base);
  }

  private activeBinding(state: RecordSyncState): Pick<LocalOutboxEntry, 'accountId' | 'projectRef' | 'notebookId'> | null {
    if (!state.accountId || !state.projectRef || !state.notebookId) return null;
    return { accountId: state.accountId, projectRef: state.projectRef, notebookId: state.notebookId };
  }

  private queueRecord(draft: LocalRepositorySnapshot, record: LocalSyncRecord, expectedVersion?: number): void {
    const binding = this.activeBinding(draft.syncState);
    if (!binding) return;
    const timestamp = this.timestamp();
    const identity = { ...binding, recordType: record.recordType, recordId: record.id };
    const key = outboxKey(identity);
    const index = draft.outbox.findIndex(entry => outboxKey(entry) === key);
    const base = this.getBaseIn(draft, record.recordType, record.id);
    const entry: LocalOutboxEntry = {
      ...identity,
      mutationId: this.createId(),
      expectedVersion: expectedVersion ?? base?.version ?? record.version,
      record: cloneSyncRecord(record),
      attemptCount: 0,
      lastAttemptAt: null,
      lastError: null,
      createdAt: index < 0 ? timestamp : draft.outbox[index].createdAt,
      updatedAt: index < 0 || timestamp >= draft.outbox[index].createdAt
        ? timestamp
        : draft.outbox[index].createdAt,
    };
    if (index < 0) draft.outbox.push(entry);
    else draft.outbox[index] = entry;
  }

  private removeActiveOutbox(draft: LocalRepositorySnapshot, record: LocalSyncRecord): void {
    const binding = this.activeBinding(draft.syncState);
    if (!binding) return;
    const key = outboxKey({ ...binding, recordType: record.recordType, recordId: record.id });
    draft.outbox = draft.outbox.filter(entry => outboxKey(entry) !== key);
  }

  private createCategoryIn(draft: LocalRepositorySnapshot, input: CreateCategoryInput): CategorySyncRecord {
    if (draft.categories.some(record => record.id === input.id)) throw new Error('A category with this ID already exists.');
    const editClock = clock(input.editedAt, input.deviceId, this.validationNow());
    const record = parseLocalSyncRecord({
      recordType: 'category',
      id: input.id,
      name: input.name,
      sortKey: input.sortKey,
      updatedAt: editClock.at,
      version: 0,
      deletedAt: null,
      updatedByDeviceId: editClock.deviceId,
      fieldUpdatedAt: { name: editClock, sortKey: editClock },
      changeSeq: 0,
    }, { now: this.validationNow() }) as CategorySyncRecord;
    draft.categories.push(record);
    this.queueRecord(draft, record);
    return cloneValue(record);
  }

  private createTaskIn(draft: LocalRepositorySnapshot, input: CreateTaskInput): TaskSyncRecord {
    if (draft.tasks.some(record => record.id === input.id)) throw new Error('A task with this ID already exists.');
    const category = draft.categories.find(record => record.id === input.categoryId && record.deletedAt === null);
    if (!category) throw new Error('The task category does not exist or is deleted.');
    const editClock = clock(input.editedAt, input.deviceId, this.validationNow());
    const record = parseLocalSyncRecord({
      recordType: 'task',
      id: input.id,
      categoryId: input.categoryId,
      title: input.title,
      scheduledDates: normalizeDates(input.scheduledDates),
      deadlineDate: input.deadlineDate,
      sortKey: input.sortKey,
      updatedAt: editClock.at,
      version: 0,
      deletedAt: null,
      updatedByDeviceId: editClock.deviceId,
      fieldUpdatedAt: {
        categoryId: editClock,
        title: editClock,
        scheduledDates: editClock,
        deadlineDate: editClock,
        sortKey: editClock,
      },
      changeSeq: 0,
    }, { now: this.validationNow() }) as TaskSyncRecord;
    draft.tasks.push(record);
    this.queueRecord(draft, record);
    return cloneValue(record);
  }

  private editCategoryIn(
    draft: LocalRepositorySnapshot,
    recordId: string,
    input: EditCategoryInput,
  ): CategorySyncRecord {
    const existing = draft.categories.find(record => record.id === recordId);
    if (!existing) throw new Error('The category does not exist.');
    if (existing.deletedAt !== null) throw new Error('A deleted category cannot be edited.');
    const record = cloneValue(existing);
    const editClock = clock(input.editedAt, input.deviceId, this.validationNow());
    let changed = false;
    for (const field of CATEGORY_SYNC_FIELDS) {
      if (!Object.hasOwn(input, field)) continue;
      const value = input[field];
      if (value === undefined || value === record[field]) continue;
      record[field] = value;
      record.fieldUpdatedAt[field] = editClock;
      changed = true;
    }
    if (!changed) return cloneValue(existing);
    const latest = newestBusinessClock(record);
    record.updatedAt = latest.at;
    record.updatedByDeviceId = latest.deviceId;
    const validated = parseLocalSyncRecord(record, { now: this.validationNow() }) as CategorySyncRecord;
    this.replaceRecord(draft, validated);
    this.queueRecord(draft, validated);
    return cloneValue(validated);
  }

  private editTaskIn(draft: LocalRepositorySnapshot, recordId: string, input: EditTaskInput): TaskSyncRecord {
    const existing = draft.tasks.find(record => record.id === recordId);
    if (!existing) throw new Error('The task does not exist.');
    if (existing.deletedAt !== null) throw new Error('A deleted task cannot be edited.');
    const parent = draft.categories.find(record => record.id === existing.categoryId && record.deletedAt === null);
    if (!parent) throw new Error('A task under a deleted category cannot be edited.');
    const record = cloneValue(existing);
    const editClock = clock(input.editedAt, input.deviceId, this.validationNow());
    let changed = false;
    for (const field of ['title', 'scheduledDates', 'deadlineDate', 'sortKey'] as const) {
      if (!Object.hasOwn(input, field)) continue;
      const rawValue = input[field];
      if (rawValue === undefined) continue;
      const value = field === 'scheduledDates' ? normalizeDates(rawValue as string[]) : rawValue;
      const equal = Array.isArray(value)
        ? value.length === record.scheduledDates.length && value.every((item, index) => item === record.scheduledDates[index])
        : value === record[field];
      if (equal) continue;
      (record as unknown as Record<string, unknown>)[field] = Array.isArray(value) ? [...value] : value;
      record.fieldUpdatedAt[field as TaskSyncField] = editClock;
      changed = true;
    }
    if (!changed) return cloneValue(existing);
    const latest = newestBusinessClock(record);
    record.updatedAt = latest.at;
    record.updatedByDeviceId = latest.deviceId;
    const validated = parseLocalSyncRecord(record, { now: this.validationNow() }) as TaskSyncRecord;
    this.replaceRecord(draft, validated);
    this.queueRecord(draft, validated);
    return cloneValue(validated);
  }

  private reorderRecordsIn(draft: LocalRepositorySnapshot, input: ReorderRecordsInput): LocalSyncRecord[] {
    const ids = new Set<string>();
    const changed: LocalSyncRecord[] = [];
    for (const assignment of input.assignments) {
      if (ids.has(assignment.id)) throw new Error('A reorder transaction contains a duplicate record ID.');
      ids.add(assignment.id);
      if (input.recordType === 'category') {
        const category = draft.categories.find(record => record.id === assignment.id && record.deletedAt === null);
        if (!category) throw new Error('A reordered category does not exist or is deleted.');
        const record = this.editCategoryIn(draft, assignment.id, {
          sortKey: assignment.sortKey,
          editedAt: input.editedAt,
          deviceId: input.deviceId,
        });
        if (record.sortKey !== category.sortKey) changed.push(record);
      } else {
        const task = draft.tasks.find(record => record.id === assignment.id && record.deletedAt === null);
        if (!task || task.categoryId !== input.categoryId) {
          throw new Error('Task reordering is limited to the task\'s current category.');
        }
        const previousSortKey = task.sortKey;
        const record = this.editTaskIn(draft, assignment.id, {
          sortKey: assignment.sortKey,
          editedAt: input.editedAt,
          deviceId: input.deviceId,
        });
        if (record.sortKey !== previousSortKey) changed.push(record);
      }
    }
    return changed;
  }

  private softDeleteIn(draft: LocalRepositorySnapshot, input: SoftDeleteInput): LocalSyncRecord[] {
    const existing = this.findRecord(draft, input.recordType, input.recordId);
    if (!existing) throw new Error('The record to delete does not exist.');
    if (existing.deletedAt !== null) return [cloneSyncRecord(existing)];
    const deleteClock = clock(input.deletedAt, input.deviceId, this.validationNow());
    const record = cloneSyncRecord(existing);
    record.deletedAt = deleteClock.at;
    record.updatedByDeviceId = deleteClock.deviceId;
    const validated = parseLocalSyncRecord(record, { now: this.validationNow() });
    this.replaceRecord(draft, validated);
    this.queueRecord(draft, validated);
    const changed: LocalSyncRecord[] = [cloneSyncRecord(validated)];
    if (validated.recordType === 'category') {
      for (const task of cascadeCategoryTombstones(validated, draft.tasks)) {
        const child = parseLocalSyncRecord(task, { now: this.validationNow() }) as TaskSyncRecord;
        this.replaceRecord(draft, child);
        this.queueRecord(draft, child);
        changed.push(cloneSyncRecord(child));
      }
    }
    return changed;
  }

  private assertCanApplyServerRecord(draft: LocalRepositorySnapshot, incoming: LocalSyncRecord): LocalSyncRecord | null {
    if (incoming.version === 0 || incoming.changeSeq === 0) {
      throw new Error('A server record must have a positive version and change sequence.');
    }
    if (draft.outbox.some(entry => entry.recordType === incoming.recordType && entry.recordId === incoming.id)) {
      throw new Error('A dirty local record must be reconciled before applying a server row.');
    }
    const current = this.findRecord(draft, incoming.recordType, incoming.id);
    const base = this.getBaseIn(draft, incoming.recordType, incoming.id);
    if (current && (!base || !recordsEqual(current, base))) {
      throw new Error('A changed local record must be reconciled before applying a server row.');
    }
    return base;
  }

  private applyServerRecordIn(draft: LocalRepositorySnapshot, record: LocalSyncRecord): LocalSyncRecord {
    const incoming = parseLocalSyncRecord(record, { now: this.validationNow() });
    const base = this.assertCanApplyServerRecord(draft, incoming);
    const canonical = applyCanonicalServerRecord(base, incoming);
    this.replaceRecord(draft, cloneSyncRecord(canonical));
    this.replaceBase(draft, canonical, canonical);
    this.removeActiveOutbox(draft, canonical);
    if (canonical.recordType === 'category') this.cascadeServerCategoryDelete(draft, canonical);
    return cloneSyncRecord(canonical);
  }

  private cascadeServerCategoryDelete(draft: LocalRepositorySnapshot, category: CategorySyncRecord): void {
    for (const task of cascadeCategoryTombstones(category, draft.tasks)) {
      const child = parseLocalSyncRecord(task, { now: this.validationNow() }) as TaskSyncRecord;
      this.replaceRecord(draft, child);
      this.queueRecord(draft, child);
    }
  }

  private applyReconciliationIn(
    draft: LocalRepositorySnapshot,
    reconciliation: RecordReconciliation,
  ): LocalSyncRecord {
    const record = parseLocalSyncRecord(reconciliation.record, { now: this.validationNow() });
    if (reconciliation.base) {
      const base = parseLocalSyncRecord(reconciliation.base, { now: this.validationNow() });
      if (base.recordType !== record.recordType || base.id !== record.id) {
        throw new Error('A reconciliation base does not match its record.');
      }
      this.replaceBase(draft, base, record);
    } else {
      this.replaceBase(draft, null, record);
    }
    this.replaceRecord(draft, record);
    if (reconciliation.uploadFields.length > 0) {
      if (reconciliation.action !== 'upload-local' && reconciliation.action !== 'upload-merged') {
        throw new Error('A reconciliation with upload fields must request an upload.');
      }
      this.queueRecord(draft, record, reconciliation.expectedVersion);
    } else {
      this.removeActiveOutbox(draft, record);
    }
    if (record.recordType === 'category') this.cascadeServerCategoryDelete(draft, record);
    return cloneSyncRecord(record);
  }

  private acknowledgeMutationIn(
    draft: LocalRepositorySnapshot,
    acknowledgement: MutationAcknowledgement,
  ): AcknowledgementResult {
    const entryIndex = draft.outbox.findIndex(entry => entry.mutationId === acknowledgement.mutationId);
    if (entryIndex < 0) return 'superseded';
    const entry = draft.outbox[entryIndex];
    if (
      entry.recordType !== acknowledgement.recordType
      || entry.recordId !== acknowledgement.record.id
      || entry.accountId !== acknowledgement.record.ownerId
      || entry.notebookId !== acknowledgement.record.notebookId
    ) throw new Error('A mutation acknowledgement does not match its outbox entry.');
    const binding = this.activeBinding(draft.syncState);
    if (
      !binding
      || binding.accountId !== entry.accountId
      || binding.projectRef !== entry.projectRef
      || binding.notebookId !== entry.notebookId
    ) throw new Error('A mutation acknowledgement belongs to an inactive sync binding.');
    const canonical = parseLocalSyncRecord(stripRemoteIdentity(acknowledgement), { now: this.validationNow() });
    if (canonical.version === 0 || canonical.changeSeq === 0) {
      throw new Error('A mutation acknowledgement must contain a canonical server record.');
    }
    if (acknowledgement.outcome === 'stale') return 'stale';
    if (canonical.version !== entry.expectedVersion + 1) {
      throw new Error('An accepted mutation acknowledgement has an unexpected version.');
    }
    const base = this.getBaseIn(draft, canonical.recordType, canonical.id);
    const accepted = applyCanonicalServerRecord(base, canonical);
    this.replaceRecord(draft, cloneSyncRecord(accepted));
    this.replaceBase(draft, accepted, accepted);
    draft.outbox.splice(entryIndex, 1);
    if (accepted.recordType === 'category') this.cascadeServerCategoryDelete(draft, accepted);
    return 'accepted';
  }

  private getBaseIn(
    draft: LocalRepositorySnapshot,
    recordType: SyncRecordType,
    recordId: string,
  ): LocalSyncRecord | null {
    const base = draft.bases.find(item => item.recordType === recordType && item.id === recordId);
    return base ? cloneSyncRecord(base) : null;
  }

  private listOutboxIn(draft: LocalRepositorySnapshot): LocalOutboxEntry[] {
    return cloneValue(draft.outbox).sort((first, second) => (
      first.createdAt.localeCompare(second.createdAt) || outboxKey(first).localeCompare(outboxKey(second))
    ));
  }

  private markOutboxAttemptIn(draft: LocalRepositorySnapshot, input: OutboxAttemptInput): LocalOutboxEntry {
    const index = draft.outbox.findIndex(entry => entry.mutationId === input.mutationId);
    if (index < 0) throw new Error('The outbox entry to update is missing.');
    const entry = draft.outbox[index];
    if (entry.recordType !== input.recordType || entry.recordId !== input.recordId) {
      throw new Error('The outbox attempt identity does not match its mutation.');
    }
    const attemptedAt = canonicalTimestamp(input.attemptedAt, 'Outbox attempt timestamp', this.validationNow());
    const updated: LocalOutboxEntry = {
      ...entry,
      attemptCount: entry.attemptCount + 1,
      lastAttemptAt: attemptedAt,
      lastError: input.error,
      updatedAt: attemptedAt >= entry.createdAt ? attemptedAt : entry.createdAt,
    };
    draft.outbox[index] = updated;
    return cloneValue(updated);
  }

  private setCursorIn(draft: LocalRepositorySnapshot, lastChangeSeq: number): void {
    const cursor = nonnegativeInteger(lastChangeSeq, 'Local change cursor');
    if (cursor < draft.syncState.lastChangeSeq) throw new Error('The local change cursor cannot move backward.');
    draft.syncState.lastChangeSeq = cursor;
  }

  private setSyncStateIn(draft: LocalRepositorySnapshot, state: RecordSyncState): void {
    const parsed = parseRecordSyncState(state);
    if (parsed.deviceId !== draft.syncState.deviceId) throw new Error('The local device identity cannot be changed.');
    const sameBinding = parsed.accountId === draft.syncState.accountId
      && parsed.projectRef === draft.syncState.projectRef
      && parsed.notebookId === draft.syncState.notebookId;
    if (sameBinding && parsed.lastChangeSeq < draft.syncState.lastChangeSeq) {
      throw new Error('The local change cursor cannot move backward.');
    }
    if (!sameBinding && parsed.lastChangeSeq !== 0) {
      throw new Error('A new sync binding must start from cursor zero.');
    }
    draft.syncState = cloneValue(parsed);
  }

  private setPreferencesIn(draft: LocalRepositorySnapshot, preferences: LocalPreferences): void {
    draft.preferences = parsePreferences(preferences);
  }

  private createRecoveryBackupIn(
    draft: LocalRepositorySnapshot,
    documentJson: string,
    reason: string,
  ): LocalRecoveryBackup {
    parseStoredText(documentJson);
    const backup: LocalRecoveryBackup = {
      backupId: this.createId(),
      createdAt: this.timestamp(),
      reason: requiredString(reason, 'Recovery backup reason'),
      documentJson,
    };
    draft.recoveryBackups.push(backup);
    draft.recoveryBackups.sort((first, second) => (
      first.createdAt.localeCompare(second.createdAt) || first.backupId.localeCompare(second.backupId)
    ));
    if (draft.recoveryBackups.length > MAX_LOCAL_RECOVERY_BACKUPS) {
      draft.recoveryBackups.splice(0, draft.recoveryBackups.length - MAX_LOCAL_RECOVERY_BACKUPS);
    }
    return cloneValue(backup);
  }

  private listRecoveryBackupsIn(draft: LocalRepositorySnapshot): LocalRecoveryBackup[] {
    return cloneValue(draft.recoveryBackups).sort((first, second) => (
      second.createdAt.localeCompare(first.createdAt) || second.backupId.localeCompare(first.backupId)
    ));
  }

  createCategory(input: CreateCategoryInput): Promise<CategorySyncRecord> {
    return this.transaction(transaction => transaction.createCategory(input));
  }

  createTask(input: CreateTaskInput): Promise<TaskSyncRecord> {
    return this.transaction(transaction => transaction.createTask(input));
  }

  editCategory(recordId: string, input: EditCategoryInput): Promise<CategorySyncRecord> {
    return this.transaction(transaction => transaction.editCategory(recordId, input));
  }

  editTask(recordId: string, input: EditTaskInput): Promise<TaskSyncRecord> {
    return this.transaction(transaction => transaction.editTask(recordId, input));
  }

  reorderRecords(input: ReorderRecordsInput): Promise<LocalSyncRecord[]> {
    return this.transaction(transaction => transaction.reorderRecords(input));
  }

  softDelete(input: SoftDeleteInput): Promise<LocalSyncRecord[]> {
    return this.transaction(transaction => transaction.softDelete(input));
  }

  applyServerRecord(record: LocalSyncRecord): Promise<LocalSyncRecord> {
    return this.transaction(transaction => transaction.applyServerRecord(record));
  }

  applyReconciliation(reconciliation: RecordReconciliation): Promise<LocalSyncRecord> {
    return this.transaction(transaction => transaction.applyReconciliation(reconciliation));
  }

  acknowledgeMutation(acknowledgement: MutationAcknowledgement): Promise<AcknowledgementResult> {
    return this.transaction(transaction => transaction.acknowledgeMutation(acknowledgement));
  }

  async getBase(recordType: SyncRecordType, recordId: string): Promise<LocalSyncRecord | null> {
    return this.serialize(async () => this.getBaseIn(await this.loadedState(), recordType, recordId));
  }

  async listOutbox(): Promise<LocalOutboxEntry[]> {
    return this.serialize(async () => this.listOutboxIn(await this.loadedState()));
  }

  markOutboxAttempt(input: OutboxAttemptInput): Promise<LocalOutboxEntry> {
    return this.transaction(transaction => transaction.markOutboxAttempt(input));
  }

  setCursor(lastChangeSeq: number): Promise<void> {
    return this.transaction(transaction => transaction.setCursor(lastChangeSeq));
  }

  setSyncState(state: RecordSyncState): Promise<void> {
    return this.transaction(transaction => transaction.setSyncState(state));
  }

  setPreferences(preferences: LocalPreferences): Promise<void> {
    return this.transaction(transaction => transaction.setPreferences(preferences));
  }

  createRecoveryBackup(documentJson: string, reason: string): Promise<LocalRecoveryBackup> {
    return this.transaction(transaction => transaction.createRecoveryBackup(documentJson, reason));
  }

  listRecoveryBackups(): Promise<LocalRecoveryBackup[]> {
    return this.serialize(async () => this.listRecoveryBackupsIn(await this.loadedState()));
  }

  async close(): Promise<void> {
    await this.serialize(async () => this.store.close?.());
  }
}

export function createInMemoryLocalRepository(
  initial: LocalRepositorySnapshot | null = null,
  dependencies: LocalRepositoryDependencies = {},
): { repository: LocalRepository; store: InMemoryLocalStateStore } {
  const store = new InMemoryLocalStateStore(initial);
  return { repository: new TransactionalLocalRepository(store, dependencies), store };
}
