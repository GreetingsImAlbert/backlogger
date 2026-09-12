import type { Notebook } from '../model.ts';
import type { ColorTheme, Theme, ViewMode } from '../storage.ts';
import type {
  CategorySyncRecord,
  LocalSyncRecord,
  MutationAcknowledgement,
  RecordReconciliation,
  RecordSyncState,
  SortKeyAssignment,
  SyncRecordType,
  TaskSyncRecord,
} from '../sync-v2/index.ts';

export const LOCAL_REPOSITORY_SCHEMA_VERSION = 2 as const;
export const LOCAL_DATABASE_URL = 'sqlite:backlogger-v2.db';
export const MAX_LOCAL_RECOVERY_BACKUPS = 20;

export interface LocalPreferences {
  viewMode: ViewMode;
  theme: Theme;
  colorTheme: ColorTheme;
}

export interface LocalOutboxEntry {
  recordType: SyncRecordType;
  recordId: string;
  accountId: string;
  projectRef: string;
  notebookId: string;
  mutationId: string;
  expectedVersion: number;
  record: LocalSyncRecord;
  attemptCount: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalRecoveryBackup {
  backupId: string;
  createdAt: string;
  reason: string;
  /** Exact validated legacy or portable JSON. This never becomes a portable export implicitly. */
  documentJson: string;
}

export interface LocalRepositorySnapshot {
  schemaVersion: typeof LOCAL_REPOSITORY_SCHEMA_VERSION;
  documentRevision: number;
  categories: CategorySyncRecord[];
  tasks: TaskSyncRecord[];
  bases: LocalSyncRecord[];
  outbox: LocalOutboxEntry[];
  syncState: RecordSyncState;
  preferences: LocalPreferences;
  recoveryBackups: LocalRecoveryBackup[];
  legacyImportComplete: boolean;
  legacyImportedAt: string | null;
}

export interface LocalReadModel {
  notebook: Notebook;
  documentRevision: number;
  records: {
    categories: CategorySyncRecord[];
    tasks: TaskSyncRecord[];
  };
  preferences: LocalPreferences;
  syncState: RecordSyncState;
  legacyImportComplete: boolean;
  legacyImportedAt: string | null;
}

export interface LegacyImportResult {
  imported: boolean;
  alreadyComplete: boolean;
  categoryCount: number;
  taskCount: number;
  backupId: string | null;
}

export interface CreateCategoryInput {
  id: string;
  name: string;
  sortKey: string;
  editedAt: string;
  deviceId: string;
}

export interface CreateTaskInput {
  id: string;
  categoryId: string;
  title: string;
  scheduledDates: string[];
  deadlineDate: string | null;
  sortKey: string;
  editedAt: string;
  deviceId: string;
}

export interface EditCategoryInput {
  name?: string;
  sortKey?: string;
  editedAt: string;
  deviceId: string;
}

export interface EditTaskInput {
  categoryId?: string;
  title?: string;
  scheduledDates?: string[];
  deadlineDate?: string | null;
  sortKey?: string;
  editedAt: string;
  deviceId: string;
}

export interface ReplaceNotebookInput {
  notebook: Notebook;
  editedAt: string;
  deviceId: string;
  minimumRevision?: number;
  recoveryBackup?: {
    documentJson: string;
    reason: string;
  };
}

export type ReorderRecordsInput =
  | {
    recordType: 'category';
    assignments: SortKeyAssignment[];
    editedAt: string;
    deviceId: string;
  }
  | {
    recordType: 'task';
    categoryId: string;
    assignments: SortKeyAssignment[];
    editedAt: string;
    deviceId: string;
  };

export interface SoftDeleteInput {
  recordType: SyncRecordType;
  recordId: string;
  deletedAt: string;
  deviceId: string;
}

export interface OutboxAttemptInput {
  mutationId: string;
  recordType: SyncRecordType;
  recordId: string;
  attemptedAt: string;
  error: string | null;
}

export type AcknowledgementResult = 'accepted' | 'stale' | 'superseded';

export interface LocalRepositoryTransaction {
  createCategory(input: CreateCategoryInput): CategorySyncRecord;
  createTask(input: CreateTaskInput): TaskSyncRecord;
  editCategory(recordId: string, input: EditCategoryInput): CategorySyncRecord;
  editTask(recordId: string, input: EditTaskInput): TaskSyncRecord;
  reorderRecords(input: ReorderRecordsInput): LocalSyncRecord[];
  softDelete(input: SoftDeleteInput): LocalSyncRecord[];
  applyServerRecord(record: LocalSyncRecord): LocalSyncRecord;
  applyReconciliation(reconciliation: RecordReconciliation): LocalSyncRecord;
  acknowledgeMutation(acknowledgement: MutationAcknowledgement): AcknowledgementResult;
  getRecord(recordType: SyncRecordType, recordId: string): LocalSyncRecord | null;
  getBase(recordType: SyncRecordType, recordId: string): LocalSyncRecord | null;
  getSyncState(): RecordSyncState;
  listOutbox(): LocalOutboxEntry[];
  markOutboxAttempt(input: OutboxAttemptInput): LocalOutboxEntry;
  setCursor(lastChangeSeq: number): void;
  setSyncState(state: RecordSyncState): void;
  setPreferences(preferences: LocalPreferences): void;
  replaceNotebook(input: ReplaceNotebookInput): void;
  createRecoveryBackup(documentJson: string, reason: string): LocalRecoveryBackup;
  listRecoveryBackups(): LocalRecoveryBackup[];
}

export interface LocalRepository {
  initialize(legacyDocumentJson: string | null): Promise<LegacyImportResult>;
  readModel(): Promise<LocalReadModel>;
  transaction<Result>(work: (transaction: LocalRepositoryTransaction) => Result | Promise<Result>): Promise<Result>;
  createCategory(input: CreateCategoryInput): Promise<CategorySyncRecord>;
  createTask(input: CreateTaskInput): Promise<TaskSyncRecord>;
  editCategory(recordId: string, input: EditCategoryInput): Promise<CategorySyncRecord>;
  editTask(recordId: string, input: EditTaskInput): Promise<TaskSyncRecord>;
  reorderRecords(input: ReorderRecordsInput): Promise<LocalSyncRecord[]>;
  softDelete(input: SoftDeleteInput): Promise<LocalSyncRecord[]>;
  applyServerRecord(record: LocalSyncRecord): Promise<LocalSyncRecord>;
  applyReconciliation(reconciliation: RecordReconciliation): Promise<LocalSyncRecord>;
  acknowledgeMutation(acknowledgement: MutationAcknowledgement): Promise<AcknowledgementResult>;
  getRecord(recordType: SyncRecordType, recordId: string): Promise<LocalSyncRecord | null>;
  getBase(recordType: SyncRecordType, recordId: string): Promise<LocalSyncRecord | null>;
  listOutbox(): Promise<LocalOutboxEntry[]>;
  markOutboxAttempt(input: OutboxAttemptInput): Promise<LocalOutboxEntry>;
  setCursor(lastChangeSeq: number): Promise<void>;
  setSyncState(state: RecordSyncState): Promise<void>;
  setPreferences(preferences: LocalPreferences): Promise<void>;
  replaceNotebook(input: ReplaceNotebookInput): Promise<void>;
  createRecoveryBackup(documentJson: string, reason: string): Promise<LocalRecoveryBackup>;
  listRecoveryBackups(): Promise<LocalRecoveryBackup[]>;
  close(): Promise<void>;
}

export interface LocalStateStore {
  load(): Promise<LocalRepositorySnapshot | null>;
  save(snapshot: LocalRepositorySnapshot): Promise<void>;
  close?(): Promise<void>;
}

export interface LocalRepositoryDependencies {
  now?: () => string;
  createId?: () => string;
}
