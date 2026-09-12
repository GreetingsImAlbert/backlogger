import { invoke } from '@tauri-apps/api/core';
import Database from '@tauri-apps/plugin-sql';
import { RECORD_SYNC_STATE_VERSION, type LocalSyncRecord } from '../sync-v2/index.ts';
import { TransactionalLocalRepository } from './repository.ts';
import {
  LOCAL_DATABASE_URL,
  type LocalRepository,
  type LocalRepositoryDependencies,
  type LocalRepositorySnapshot,
  type LocalStateStore,
} from './types.ts';

export interface LocalSqlStatement {
  query: string;
  values: unknown[];
}

export interface LocalSqlDatabase {
  select<Row extends Record<string, unknown>>(query: string, values?: unknown[]): Promise<Row[]>;
  transaction(statements: LocalSqlStatement[]): Promise<void>;
  close?(): Promise<void>;
}

interface CategoryRow extends Record<string, unknown> {
  id: string;
  name: string;
  sort_key: string;
  updated_at: string;
  version: number;
  deleted_at: string | null;
  updated_by_device_id: string;
  field_updated_at_json: string;
  change_seq: number;
}

interface TaskRow extends CategoryRow {
  category_id: string;
  title: string;
  scheduled_dates_json: string;
  deadline_date: string | null;
}

interface JsonRecordRow extends Record<string, unknown> {
  record_json: string;
}

interface OutboxRow extends JsonRecordRow {
  record_type: 'category' | 'task';
  record_id: string;
  account_id: string;
  project_ref: string;
  notebook_id: string;
  mutation_id: string;
  expected_version: number;
  attempt_count: number;
  last_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface MetaRow extends Record<string, unknown> {
  schema_version: number;
  device_id: string;
  account_id: string | null;
  project_ref: string | null;
  notebook_id: string | null;
  last_change_seq: number;
  state: string;
  last_error: string | null;
  legacy_import_complete: number;
  legacy_imported_at: string | null;
}

interface PreferenceRow extends Record<string, unknown> {
  view_mode: 'all' | 'today' | 'tomorrow';
  theme: 'dark' | 'light';
  color_theme: 'neutral' | 'violet' | 'ocean' | 'forest' | 'rose';
}

interface BackupRow extends Record<string, unknown> {
  backup_id: string;
  created_at: string;
  reason: string;
  document_json: string;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} is not an integer.`);
  return value;
}

function categoryFromRow(row: CategoryRow): LocalSyncRecord {
  return {
    recordType: 'category',
    id: row.id,
    name: row.name,
    sortKey: row.sort_key,
    updatedAt: row.updated_at,
    version: integer(row.version, 'Category version'),
    deletedAt: row.deleted_at,
    updatedByDeviceId: row.updated_by_device_id,
    fieldUpdatedAt: parseJson(row.field_updated_at_json, 'Category field clocks') as never,
    changeSeq: integer(row.change_seq, 'Category change sequence'),
  };
}

function taskFromRow(row: TaskRow): LocalSyncRecord {
  return {
    recordType: 'task',
    id: row.id,
    categoryId: row.category_id,
    title: row.title,
    scheduledDates: parseJson(row.scheduled_dates_json, 'Task scheduled dates') as string[],
    deadlineDate: row.deadline_date,
    sortKey: row.sort_key,
    updatedAt: row.updated_at,
    version: integer(row.version, 'Task version'),
    deletedAt: row.deleted_at,
    updatedByDeviceId: row.updated_by_device_id,
    fieldUpdatedAt: parseJson(row.field_updated_at_json, 'Task field clocks') as never,
    changeSeq: integer(row.change_seq, 'Task change sequence'),
  };
}

function insert(query: string, values: unknown[]): LocalSqlStatement {
  return { query, values };
}

export class SqliteLocalStateStore implements LocalStateStore {
  private readonly database: LocalSqlDatabase;

  constructor(database: LocalSqlDatabase) {
    this.database = database;
  }

  async load(): Promise<LocalRepositorySnapshot | null> {
    const metaRows = await this.database.select<MetaRow>('SELECT * FROM local_sync_meta WHERE singleton = 1');
    if (metaRows.length === 0) {
      const counts = await this.database.select<{ row_count: number }>(
        `SELECT (
          (SELECT COUNT(*) FROM local_sync_categories)
          + (SELECT COUNT(*) FROM local_sync_tasks)
          + (SELECT COUNT(*) FROM local_sync_bases)
          + (SELECT COUNT(*) FROM local_sync_outbox)
          + (SELECT COUNT(*) FROM local_preferences)
          + (SELECT COUNT(*) FROM local_recovery_backups)
        ) AS row_count`,
      );
      if (integer(counts[0]?.row_count ?? 0, 'Local database row count') !== 0) {
        throw new Error('The local database has data but no repository metadata.');
      }
      return null;
    }
    if (metaRows.length !== 1) throw new Error('The local database has duplicate repository metadata.');
    const [categories, tasks, bases, outbox, preferences, backups] = await Promise.all([
      this.database.select<CategoryRow>('SELECT * FROM local_sync_categories ORDER BY sort_key, id'),
      this.database.select<TaskRow>('SELECT * FROM local_sync_tasks ORDER BY category_id, sort_key, id'),
      this.database.select<JsonRecordRow>('SELECT record_json FROM local_sync_bases ORDER BY record_type, record_id'),
      this.database.select<OutboxRow>(
        'SELECT * FROM local_sync_outbox ORDER BY account_id, project_ref, notebook_id, updated_at, record_type, record_id',
      ),
      this.database.select<PreferenceRow>('SELECT view_mode, theme, color_theme FROM local_preferences WHERE singleton = 1'),
      this.database.select<BackupRow>('SELECT * FROM local_recovery_backups ORDER BY created_at, backup_id'),
    ]);
    if (preferences.length !== 1) throw new Error('The local database is missing its preferences.');
    const meta = metaRows[0];
    return {
      schemaVersion: integer(meta.schema_version, 'Local repository schema version') as 1,
      categories: categories.map(categoryFromRow) as LocalRepositorySnapshot['categories'],
      tasks: tasks.map(taskFromRow) as LocalRepositorySnapshot['tasks'],
      bases: bases.map(row => parseJson(row.record_json, 'Local base row') as LocalSyncRecord),
      outbox: outbox.map(row => ({
        recordType: row.record_type,
        recordId: row.record_id,
        accountId: row.account_id,
        projectRef: row.project_ref,
        notebookId: row.notebook_id,
        mutationId: row.mutation_id,
        expectedVersion: integer(row.expected_version, 'Outbox expected version'),
        record: parseJson(row.record_json, 'Local outbox row') as LocalSyncRecord,
        attemptCount: integer(row.attempt_count, 'Outbox attempt count'),
        lastAttemptAt: row.last_attempt_at,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      syncState: {
        schemaVersion: RECORD_SYNC_STATE_VERSION,
        deviceId: meta.device_id,
        accountId: meta.account_id,
        projectRef: meta.project_ref,
        notebookId: meta.notebook_id,
        lastChangeSeq: integer(meta.last_change_seq, 'Local change cursor'),
        status: meta.state as LocalRepositorySnapshot['syncState']['status'],
        lastError: meta.last_error,
      },
      preferences: {
        viewMode: preferences[0].view_mode,
        theme: preferences[0].theme,
        colorTheme: preferences[0].color_theme,
      },
      recoveryBackups: backups.map(row => ({
        backupId: row.backup_id,
        createdAt: row.created_at,
        reason: row.reason,
        documentJson: row.document_json,
      })),
      legacyImportComplete: integer(meta.legacy_import_complete, 'Legacy import marker') === 1,
      legacyImportedAt: meta.legacy_imported_at,
    };
  }

  async save(snapshot: LocalRepositorySnapshot): Promise<void> {
    const statements: LocalSqlStatement[] = [
      insert('DELETE FROM local_sync_tasks', []),
      insert('DELETE FROM local_sync_categories', []),
      insert('DELETE FROM local_sync_bases', []),
      insert('DELETE FROM local_sync_outbox', []),
      insert('DELETE FROM local_sync_meta', []),
      insert('DELETE FROM local_preferences', []),
      insert('DELETE FROM local_recovery_backups', []),
    ];
    for (const record of snapshot.categories) {
      statements.push(insert(
        `INSERT INTO local_sync_categories (
          id, name, sort_key, updated_at, version, deleted_at, updated_by_device_id, field_updated_at_json, change_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id, record.name, record.sortKey, record.updatedAt, record.version, record.deletedAt,
          record.updatedByDeviceId, JSON.stringify(record.fieldUpdatedAt), record.changeSeq,
        ],
      ));
    }
    for (const record of snapshot.tasks) {
      statements.push(insert(
        `INSERT INTO local_sync_tasks (
          id, category_id, title, scheduled_dates_json, deadline_date, sort_key, updated_at, version,
          deleted_at, updated_by_device_id, field_updated_at_json, change_seq
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id, record.categoryId, record.title, JSON.stringify(record.scheduledDates), record.deadlineDate,
          record.sortKey, record.updatedAt, record.version, record.deletedAt, record.updatedByDeviceId,
          JSON.stringify(record.fieldUpdatedAt), record.changeSeq,
        ],
      ));
    }
    for (const record of snapshot.bases) {
      statements.push(insert(
        'INSERT INTO local_sync_bases (record_type, record_id, record_json) VALUES (?, ?, ?)',
        [record.recordType, record.id, JSON.stringify(record)],
      ));
    }
    for (const entry of snapshot.outbox) {
      statements.push(insert(
        `INSERT INTO local_sync_outbox (
          record_type, record_id, account_id, project_ref, notebook_id, mutation_id, expected_version,
          record_json, attempt_count, last_attempt_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entry.recordType, entry.recordId, entry.accountId, entry.projectRef, entry.notebookId,
          entry.mutationId, entry.expectedVersion, JSON.stringify(entry.record), entry.attemptCount,
          entry.lastAttemptAt, entry.lastError, entry.createdAt, entry.updatedAt,
        ],
      ));
    }
    statements.push(insert(
      `INSERT INTO local_sync_meta (
        singleton, schema_version, device_id, account_id, project_ref, notebook_id, last_change_seq,
        state, last_error, legacy_import_complete, legacy_imported_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshot.schemaVersion, snapshot.syncState.deviceId, snapshot.syncState.accountId,
        snapshot.syncState.projectRef, snapshot.syncState.notebookId, snapshot.syncState.lastChangeSeq,
        snapshot.syncState.status, snapshot.syncState.lastError, snapshot.legacyImportComplete ? 1 : 0,
        snapshot.legacyImportedAt,
      ],
    ));
    statements.push(insert(
      'INSERT INTO local_preferences (singleton, view_mode, theme, color_theme) VALUES (1, ?, ?, ?)',
      [snapshot.preferences.viewMode, snapshot.preferences.theme, snapshot.preferences.colorTheme],
    ));
    for (const backup of snapshot.recoveryBackups) {
      statements.push(insert(
        'INSERT INTO local_recovery_backups (backup_id, created_at, reason, document_json) VALUES (?, ?, ?, ?)',
        [backup.backupId, backup.createdAt, backup.reason, backup.documentJson],
      ));
    }
    await this.database.transaction(statements);
  }

  async close(): Promise<void> {
    await this.database.close?.();
  }
}

class TauriLocalSqlDatabase implements LocalSqlDatabase {
  private readonly database: Database;

  private constructor(database: Database) {
    this.database = database;
  }

  static async open(): Promise<TauriLocalSqlDatabase> {
    return new TauriLocalSqlDatabase(await Database.load(LOCAL_DATABASE_URL));
  }

  select<Row extends Record<string, unknown>>(query: string, values: unknown[] = []): Promise<Row[]> {
    return this.database.select<Row[]>(query, values);
  }

  async transaction(statements: LocalSqlStatement[]): Promise<void> {
    await invoke('execute_local_database_transaction', {
      database: LOCAL_DATABASE_URL,
      statements,
    });
  }

  async close(): Promise<void> {
    await this.database.close(LOCAL_DATABASE_URL);
  }
}

export async function openTauriLocalRepository(
  dependencies: LocalRepositoryDependencies = {},
): Promise<LocalRepository> {
  const database = await TauriLocalSqlDatabase.open();
  const repository = new TransactionalLocalRepository(new SqliteLocalStateStore(database), dependencies);
  try {
    const legacyDocumentJson = await invoke<string | null>('read_legacy_notebook_for_migration');
    await repository.initialize(legacyDocumentJson);
    return repository;
  } catch (error) {
    try {
      await repository.close();
    } catch {
      // Preserve the import/open failure, which is the actionable error.
    }
    throw error;
  }
}
