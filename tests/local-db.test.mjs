import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openBrowserLocalRepository, BROWSER_LOCAL_REPOSITORY_KEY } from '../src/local-db/browser.ts';
import {
  InMemoryLocalStateStore,
  TransactionalLocalRepository,
} from '../src/local-db/repository.ts';
import { SqliteLocalStateStore } from '../src/local-db/sqlite.ts';
import { reconcileRecord } from '../src/sync-v2/index.ts';

const NOW = '2026-09-12T04:00:00.000Z';
const LATER = '2026-09-12T04:01:00.000Z';
const INITIAL_MIGRATION_SQL = await readFile(
  new URL('../src-tauri/migrations/0001_local_sync_v2.sql', import.meta.url),
  'utf8',
);
const REVISION_MIGRATION_SQL = await readFile(
  new URL('../src-tauri/migrations/0002_local_document_revision.sql', import.meta.url),
  'utf8',
);

function dependencies(prefix = 'generated') {
  let sequence = 0;
  return {
    now: () => NOW,
    createId: () => `${prefix}-${++sequence}`,
  };
}

function legacyDocument(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 8,
    categories: [
      {
        id: 'category-a',
        name: 'First',
        tasks: [
          {
            id: 'task-a',
            title: 'Alpha',
            scheduledDates: ['2026-09-14', '2026-09-12'],
            deadlineDate: '2026-09-20',
          },
          {
            id: 'task-b',
            title: 'Beta',
            scheduledDates: [],
            deadlineDate: null,
          },
        ],
      },
      { id: 'category-b', name: 'Second', tasks: [] },
    ],
    preferences: { viewMode: 'tomorrow', theme: 'light', colorTheme: 'ocean' },
    ...overrides,
  };
}

function legacyJson(overrides = {}) {
  return JSON.stringify(legacyDocument(overrides), null, 2);
}

class NodeSqliteDatabase {
  failAfterStatement = null;
  closed = false;

  constructor(path) {
    this.database = new DatabaseSync(path);
    this.database.exec(INITIAL_MIGRATION_SQL);
    const columns = this.database.prepare('PRAGMA table_info(local_sync_meta)').all();
    if (!columns.some(column => column.name === 'document_revision')) {
      this.database.exec(REVISION_MIGRATION_SQL);
    }
  }

  async select(query, values = []) {
    return this.database.prepare(query).all(...values);
  }

  async transaction(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (let index = 0; index < statements.length; index += 1) {
        if (this.failAfterStatement === index) throw new Error('Injected interrupted SQLite transaction.');
        const statement = statements[index];
        this.database.prepare(statement.query).run(...statement.values);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    } finally {
      this.failAfterStatement = null;
    }
  }

  async close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
}

async function sqliteFixture(t, name = 'repository.db') {
  const directory = await mkdtemp(join(tmpdir(), 'backlogger-local-db-'));
  const path = join(directory, name);
  const databases = [];
  const open = (prefix = 'sqlite') => {
    const database = new NodeSqliteDatabase(path);
    databases.push(database);
    const repository = new TransactionalLocalRepository(
      new SqliteLocalStateStore(database),
      dependencies(prefix),
    );
    return { database, repository };
  };
  const initial = open();
  t.after(async () => {
    for (const database of databases) await database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { path, ...initial, reopen: open };
}

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, value);
  }
}

test('SQLite imports a populated legacy notebook atomically and preserves its exact recovery source', async t => {
  const { database, repository, reopen } = await sqliteFixture(t);
  const raw = legacyJson();
  const result = await repository.initialize(raw);

  assert.deepEqual(result, {
    imported: true,
    alreadyComplete: false,
    categoryCount: 2,
    taskCount: 2,
    backupId: 'sqlite-2',
  });
  const model = await repository.readModel();
  assert.equal(model.documentRevision, 8);
  assert.deepEqual(model.notebook, {
    categories: [
      {
        id: 'category-a',
        name: 'First',
        tasks: [
          {
            id: 'task-a',
            title: 'Alpha',
            scheduledDates: ['2026-09-12', '2026-09-14'],
            deadlineDate: '2026-09-20',
          },
          { id: 'task-b', title: 'Beta', scheduledDates: [], deadlineDate: null },
        ],
      },
      { id: 'category-b', name: 'Second', tasks: [] },
    ],
  });
  assert.deepEqual(model.preferences, legacyDocument().preferences);
  assert.equal(new Set(model.records.categories.map(record => record.sortKey)).size, 2);
  assert.equal(new Set(model.records.tasks.map(record => record.sortKey)).size, 2);
  assert.ok(model.records.categories.every(record => record.version === 0 && record.changeSeq === 0));
  const backups = await database.select('SELECT backup_id, document_json FROM local_recovery_backups');
  assert.deepEqual(
    backups.map(row => ({ backup_id: row.backup_id, document_json: row.document_json })),
    [{ backup_id: 'sqlite-2', document_json: raw }],
  );

  await repository.close();
  const { repository: reopened } = reopen('android-reopen');
  const repeated = await reopened.initialize(legacyJson({ categories: [] }));
  assert.equal(repeated.alreadyComplete, true);
  assert.equal(repeated.imported, false);
  assert.deepEqual((await reopened.readModel()).notebook, model.notebook);
});

test('clean install and valid empty legacy notebook both initialize durably', async t => {
  const clean = await sqliteFixture(t, 'clean.db');
  assert.deepEqual(await clean.repository.initialize(null), {
    imported: false,
    alreadyComplete: false,
    categoryCount: 0,
    taskCount: 0,
    backupId: null,
  });
  assert.equal((await clean.repository.readModel()).legacyImportComplete, true);
  await clean.repository.close();

  const empty = await sqliteFixture(t, 'empty.db');
  const raw = legacyJson({ categories: [] });
  const result = await empty.repository.initialize(raw);
  assert.equal(result.imported, true);
  assert.equal(result.categoryCount, 0);
  assert.equal(result.taskCount, 0);
  assert.equal((await empty.database.select('SELECT COUNT(*) AS count FROM local_recovery_backups'))[0].count, 1);
  await empty.repository.close();
});

test('empty, malformed, and globally duplicated legacy files roll back without marking import complete', async t => {
  const cases = [
    ['', /not valid JSON/i],
    ['{"schemaVersion":', /not valid JSON/i],
    [legacyJson({
      categories: [
        { id: 'one', name: 'One', tasks: [{ id: 'same', title: 'A', scheduledDates: [], deadlineDate: null }] },
        { id: 'two', name: 'Two', tasks: [{ id: 'same', title: 'B', scheduledDates: [], deadlineDate: null }] },
      ],
    }), /duplicate task ids across categories/i],
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const fixture = await sqliteFixture(t, `invalid-${index}.db`);
    const [raw, message] = cases[index];
    await assert.rejects(fixture.repository.initialize(raw), message);
    assert.equal((await fixture.database.select('SELECT COUNT(*) AS count FROM local_sync_meta'))[0].count, 0);
    assert.equal((await fixture.database.select('SELECT COUNT(*) AS count FROM local_sync_categories'))[0].count, 0);
    assert.equal(raw, cases[index][0]);
    await fixture.repository.close();
  }
});

test('an interrupted SQLite import rolls back every table and succeeds on the next launch', async t => {
  const { database, repository, reopen } = await sqliteFixture(t, 'interrupted.db');
  database.failAfterStatement = 9;
  await assert.rejects(repository.initialize(legacyJson()), /interrupted SQLite transaction/i);
  assert.equal((await database.select('SELECT COUNT(*) AS count FROM local_sync_meta'))[0].count, 0);
  assert.equal((await database.select('SELECT COUNT(*) AS count FROM local_sync_categories'))[0].count, 0);
  assert.equal((await database.select('SELECT COUNT(*) AS count FROM local_recovery_backups'))[0].count, 0);
  await repository.close();

  const { repository: reopened } = reopen('retry');
  const result = await reopened.initialize(legacyJson());
  assert.equal(result.imported, true);
  assert.equal((await reopened.readModel()).notebook.categories.length, 2);
});

test('repository callbacks and failed durable saves leave the committed state untouched', async () => {
  const store = new InMemoryLocalStateStore();
  const repository = new TransactionalLocalRepository(store, dependencies('rollback'));
  await repository.initialize(null);
  await assert.rejects(
    repository.transaction(transaction => {
      transaction.createCategory({
        id: 'category-a', name: 'Temporary', sortKey: '4000000000000000', editedAt: NOW, deviceId: 'device-a',
      });
      throw new Error('abort callback');
    }),
    /abort callback/,
  );
  assert.deepEqual((await repository.readModel()).notebook.categories, []);

  store.failNextSave = true;
  await assert.rejects(repository.createCategory({
    id: 'category-b', name: 'Failed save', sortKey: '4000000000000000', editedAt: NOW, deviceId: 'device-a',
  }), /injected local store failure/i);
  assert.deepEqual((await repository.readModel()).notebook.categories, []);
});

test('repository applies canonical rows and persists three-way reconciliation as one dirty intent', async () => {
  const { repository } = (() => {
    const store = new InMemoryLocalStateStore();
    return { repository: new TransactionalLocalRepository(store, dependencies('reconcile')) };
  })();
  await repository.initialize(null);
  const initial = await repository.readModel();
  await repository.setSyncState({
    ...initial.syncState,
    accountId: 'owner-a',
    projectRef: 'project-a',
    notebookId: 'notebook-a',
    status: 'live',
  });
  const base = await repository.applyServerRecord({
    recordType: 'category',
    id: 'category-a',
    name: 'Server name',
    sortKey: '4000000000000000',
    updatedAt: NOW,
    version: 1,
    deletedAt: null,
    updatedByDeviceId: 'server-a',
    fieldUpdatedAt: {
      name: { at: NOW, deviceId: 'server-a' },
      sortKey: { at: NOW, deviceId: 'server-a' },
    },
    changeSeq: 1,
  });
  const local = await repository.editCategory('category-a', {
    name: 'Local name', editedAt: LATER, deviceId: initial.syncState.deviceId,
  });
  const server = {
    ...base,
    sortKey: '8000000000000000',
    updatedAt: LATER,
    updatedByDeviceId: 'server-b',
    fieldUpdatedAt: {
      ...base.fieldUpdatedAt,
      sortKey: { at: LATER, deviceId: 'server-b' },
    },
    version: 2,
    changeSeq: 2,
  };
  const reconciliation = reconcileRecord(base, local, server, { now: Date.parse(NOW) });
  const merged = await repository.applyReconciliation(reconciliation);
  assert.equal(merged.name, 'Local name');
  assert.equal(merged.sortKey, '8000000000000000');
  assert.equal((await repository.getBase('category', 'category-a'))?.version, 2);
  const [entry] = await repository.listOutbox();
  assert.equal(entry.expectedVersion, 2);
  assert.equal(entry.record.name, 'Local name');
  assert.equal(entry.record.sortKey, '8000000000000000');
  await repository.markOutboxAttempt({
    mutationId: entry.mutationId,
    recordType: 'category',
    recordId: 'category-a',
    attemptedAt: LATER,
    error: 'offline',
  });
  assert.equal((await repository.listOutbox())[0].attemptCount, 1);
});

test('repository reordering is atomic and task assignments cannot cross categories', async () => {
  const store = new InMemoryLocalStateStore();
  const repository = new TransactionalLocalRepository(store, dependencies('reorder'));
  await repository.initialize(null);
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.transaction(transaction => {
    transaction.createCategory({
      id: 'category-a', name: 'A', sortKey: '4000000000000000', editedAt: NOW, deviceId,
    });
    transaction.createCategory({
      id: 'category-b', name: 'B', sortKey: '8000000000000000', editedAt: NOW, deviceId,
    });
    transaction.createTask({
      id: 'task-a', categoryId: 'category-a', title: 'Task', scheduledDates: [], deadlineDate: null,
      sortKey: '4000000000000000', editedAt: NOW, deviceId,
    });
  });
  await repository.reorderRecords({
    recordType: 'category',
    assignments: [
      { id: 'category-a', sortKey: '9000000000000000' },
      { id: 'category-b', sortKey: '1000000000000000' },
    ],
    editedAt: LATER,
    deviceId,
  });
  assert.deepEqual((await repository.readModel()).notebook.categories.map(category => category.id), ['category-b', 'category-a']);
  await assert.rejects(repository.reorderRecords({
    recordType: 'task',
    categoryId: 'category-b',
    assignments: [{ id: 'task-a', sortKey: '8000000000000000' }],
    editedAt: LATER,
    deviceId,
  }), /current category/i);
  assert.equal((await repository.readModel()).records.tasks[0].sortKey, '4000000000000000');
});

test('offline edits replace an older mutation so a late acknowledgement cannot overwrite them', async () => {
  const store = new InMemoryLocalStateStore();
  const repository = new TransactionalLocalRepository(store, dependencies('offline'));
  await repository.initialize(null);
  const initial = await repository.readModel();
  await repository.setSyncState({
    ...initial.syncState,
    accountId: 'owner-a',
    projectRef: 'project-a',
    notebookId: 'notebook-a',
    status: 'live',
  });
  await repository.createCategory({
    id: 'category-a', name: 'First edit', sortKey: '4000000000000000', editedAt: NOW,
    deviceId: initial.syncState.deviceId,
  });
  const firstMutation = (await repository.listOutbox())[0];
  await repository.setSyncState({ ...(await repository.readModel()).syncState, status: 'disconnected' });
  await repository.editCategory('category-a', {
    name: 'Offline edit', editedAt: LATER, deviceId: initial.syncState.deviceId,
  });
  const secondMutation = (await repository.listOutbox())[0];
  assert.notEqual(secondMutation.mutationId, firstMutation.mutationId);
  assert.equal(await repository.acknowledgeMutation({
    mutationId: firstMutation.mutationId,
    outcome: 'accepted',
    recordType: 'category',
    record: {
      ...firstMutation.record,
      notebookId: 'notebook-a',
      ownerId: 'owner-a',
      version: 1,
      changeSeq: 1,
    },
  }), 'superseded');
  assert.equal((await repository.readModel()).notebook.categories[0].name, 'Offline edit');
  assert.equal((await repository.listOutbox())[0].mutationId, secondMutation.mutationId);
});

test('local transactions persist records, metadata, coalesced outbox work, acknowledgements, and tombstones', async t => {
  const { repository, reopen } = await sqliteFixture(t, 'roundtrip.db');
  await repository.initialize(null);
  const initial = await repository.readModel();
  await repository.setSyncState({
    ...initial.syncState,
    accountId: 'owner-a',
    projectRef: 'project-a',
    notebookId: 'notebook-a',
    status: 'live',
  });
  await repository.transaction(transaction => {
    transaction.createCategory({
      id: 'category-a', name: 'Category', sortKey: '4000000000000000', editedAt: NOW, deviceId: initial.syncState.deviceId,
    });
    transaction.createTask({
      id: 'task-a', categoryId: 'category-a', title: 'Task', scheduledDates: ['2026-09-12'],
      deadlineDate: null, sortKey: '4000000000000000', editedAt: NOW, deviceId: initial.syncState.deviceId,
    });
    transaction.setCursor(7);
    transaction.setPreferences({ viewMode: 'today', theme: 'light', colorTheme: 'forest' });
  });
  await repository.editCategory('category-a', {
    name: 'Category renamed', editedAt: LATER, deviceId: initial.syncState.deviceId,
  });
  let outbox = await repository.listOutbox();
  assert.equal(outbox.length, 2);
  const categoryEntry = outbox.find(entry => entry.recordType === 'category');
  assert.ok(categoryEntry);
  assert.equal(categoryEntry.record.name, 'Category renamed');
  assert.equal(categoryEntry.expectedVersion, 0);

  assert.equal(await repository.acknowledgeMutation({
    mutationId: categoryEntry.mutationId,
    outcome: 'accepted',
    recordType: 'category',
    record: {
      ...categoryEntry.record,
      notebookId: 'notebook-a',
      ownerId: 'owner-a',
      version: 1,
      changeSeq: 8,
    },
  }), 'accepted');
  assert.equal((await repository.getBase('category', 'category-a'))?.version, 1);
  assert.equal((await repository.listOutbox()).length, 1);

  await repository.softDelete({
    recordType: 'category', recordId: 'category-a', deletedAt: LATER, deviceId: initial.syncState.deviceId,
  });
  assert.deepEqual((await repository.readModel()).notebook.categories, []);
  outbox = await repository.listOutbox();
  assert.equal(outbox.length, 2);
  assert.ok(outbox.every(entry => entry.record.deletedAt === LATER));
  await repository.close();

  const { repository: reopened } = reopen('windows-reopen');
  assert.equal((await reopened.initialize(null)).alreadyComplete, true);
  const reopenedModel = await reopened.readModel();
  assert.equal(reopenedModel.syncState.lastChangeSeq, 7);
  assert.deepEqual(reopenedModel.preferences, { viewMode: 'today', theme: 'light', colorTheme: 'forest' });
  assert.equal(reopenedModel.records.categories[0].deletedAt, LATER);
  assert.equal(reopenedModel.records.tasks[0].deletedAt, LATER);
  assert.equal((await reopened.listOutbox()).length, 2);
  await assert.rejects(reopened.setCursor(6), /cannot move backward/i);
  assert.equal((await reopened.readModel()).syncState.lastChangeSeq, 7);
});

test('browser preview imports once without modifying legacy localStorage', async () => {
  const storage = new MemoryStorage();
  const raw = legacyJson();
  storage.setItem('backlogger.document.v1', raw);
  const repository = await openBrowserLocalRepository(storage, dependencies('browser'));
  assert.deepEqual((await repository.readModel()).notebook.categories.map(category => category.id), ['category-a', 'category-b']);
  assert.equal(storage.getItem('backlogger.document.v1'), raw);
  assert.ok(storage.getItem(BROWSER_LOCAL_REPOSITORY_KEY));

  storage.setItem('backlogger.document.v1', legacyJson({ categories: [] }));
  const reopened = await openBrowserLocalRepository(storage, dependencies('browser-reopen'));
  assert.deepEqual((await reopened.readModel()).notebook.categories.map(category => category.id), ['category-a', 'category-b']);
});

test('whole-notebook replacement is atomic, preserves preferences, and records hidden tombstones', async () => {
  const store = new InMemoryLocalStateStore();
  const repository = new TransactionalLocalRepository(store, dependencies('replace'));
  await repository.initialize(legacyJson());
  const before = await repository.readModel();
  const backup = JSON.stringify({ schemaVersion: 2, revision: 8, categories: before.notebook.categories });

  await repository.replaceNotebook({
    notebook: {
      categories: [{
        ...before.notebook.categories[0],
        name: 'Imported',
        tasks: [before.notebook.categories[0].tasks[0]],
      }],
    },
    editedAt: LATER,
    deviceId: before.syncState.deviceId,
    minimumRevision: 20,
    recoveryBackup: { documentJson: backup, reason: 'before-import-replacement' },
  });
  const replaced = await repository.readModel();
  assert.equal(replaced.documentRevision, 20);
  assert.deepEqual(replaced.preferences, before.preferences);
  assert.equal(replaced.notebook.categories[0].name, 'Imported');
  assert.equal(replaced.records.categories.find(record => record.id === 'category-b')?.deletedAt, LATER);
  assert.equal(replaced.records.tasks.find(record => record.id === 'task-b')?.deletedAt, LATER);
  assert.equal((await repository.listRecoveryBackups())[0].reason, 'before-import-replacement');

  const committedBeforeFailure = store.inspect();
  store.failNextSave = true;
  await assert.rejects(repository.replaceNotebook({
    notebook: { categories: [] },
    editedAt: LATER,
    deviceId: before.syncState.deviceId,
  }), /injected local store failure/i);
  assert.deepEqual(store.inspect(), committedBeforeFailure);
});

test('undo-style replacement recreates deleted IDs without removing their tombstones', async () => {
  const { repository } = (() => {
    const store = new InMemoryLocalStateStore();
    return { repository: new TransactionalLocalRepository(store, dependencies('undo')) };
  })();
  await repository.initialize(legacyJson());
  const original = (await repository.readModel()).notebook;
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.replaceNotebook({
    notebook: { categories: [original.categories[0]] },
    editedAt: LATER,
    deviceId,
  });
  await repository.replaceNotebook({
    notebook: original,
    editedAt: LATER,
    deviceId,
  });

  const restored = await repository.readModel();
  const restoredSecond = restored.notebook.categories.find(category => category.name === 'Second');
  assert.ok(restoredSecond);
  assert.notEqual(restoredSecond.id, 'category-b');
  assert.equal(restored.records.categories.find(record => record.id === 'category-b')?.deletedAt, LATER);
  assert.equal(restored.records.categories.find(record => record.id === restoredSecond.id)?.deletedAt, null);
});

test('whole-notebook replacement persists category order, task order, and cross-category task moves', async () => {
  const store = new InMemoryLocalStateStore();
  const repository = new TransactionalLocalRepository(store, dependencies('ordering'));
  await repository.initialize(legacyJson());
  const initial = await repository.readModel();
  const [first, second] = initial.notebook.categories;
  const [alpha, beta] = first.tasks;

  await repository.replaceNotebook({
    notebook: {
      categories: [
        { ...second, tasks: [beta, alpha] },
        { ...first, tasks: [] },
      ],
    },
    editedAt: LATER,
    deviceId: initial.syncState.deviceId,
  });

  const moved = await repository.readModel();
  assert.deepEqual(moved.notebook.categories.map(category => category.id), ['category-b', 'category-a']);
  assert.deepEqual(moved.notebook.categories[0].tasks.map(task => task.id), ['task-b', 'task-a']);
  assert.ok(moved.records.tasks.every(task => task.categoryId === 'category-b'));
});
