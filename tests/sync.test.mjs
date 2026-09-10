import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStoredDocument } from '../src/storage.ts';
import {
  applySyncConflict,
  findCommonSnapshotAncestor,
  hasValidSnapshotParentRevisions,
  hasCompleteSnapshotAncestry,
  isSnapshotAncestor,
  makeCheckpointSnapshot,
  makeSyncManifest,
  makeSyncSnapshot,
  makeSyncState,
  mergeEverything,
  mergeNotebooks,
  parseSyncManifest,
  parseSyncSnapshot,
  parseSyncState,
  migrateSyncState,
  reconcileManifestHeadIds,
  snapshotLeaves,
  storedDocumentFromSyncSnapshot,
  SYNC_CHECKPOINT_VERSION,
  SYNC_SCHEMA_VERSION,
  SYNC_SNAPSHOT_RETENTION_LIMIT,
  LEGACY_SYNC_SCHEMA_VERSION,
} from '../src/sync.ts';

const notebook = {
  categories: [{
    id: 'category-1',
    name: 'ME 190',
    tasks: [{
      id: 'task-1',
      title: 'Presentation',
      scheduledDates: ['2026-09-07'],
      deadlineDate: '2026-09-11',
    }],
  }],
};

test('sync snapshots preserve notebook data while keeping device preferences local', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const document = makeStoredDocument(notebook, 4, 'today', 'light');
  const snapshot = makeSyncSnapshot(document, state, ['parent-1', 'parent-1']);
  assert.equal(snapshot.deviceId, 'device-1');
  assert.deepEqual(snapshot.parentSnapshotIds, ['parent-1']);
  assert.deepEqual(snapshot.categories, document.categories);
  assert.equal('preferences' in snapshot, false);
  const restored = parseSyncState({ ...state, pendingSnapshots: [snapshot] });
  assert.deepEqual(restored.pendingSnapshots[0], snapshot);
});

test('checkpoint snapshots are self-contained and use an explicit compatible version', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const checkpoint = makeCheckpointSnapshot(makeStoredDocument(notebook, 4, 'all'), state);
  assert.equal(checkpoint.type, 'checkpoint');
  assert.equal(checkpoint.checkpointVersion, SYNC_CHECKPOINT_VERSION);
  assert.deepEqual(checkpoint.parentSnapshotIds, []);
  assert.deepEqual(parseSyncSnapshot(checkpoint).categories, checkpoint.categories);
  assert.equal(SYNC_SNAPSHOT_RETENTION_LIMIT, 30);
  assert.throws(() => parseSyncSnapshot({ ...checkpoint, checkpointVersion: 99 }), /checkpoint version/);
});

test('sync manifests remain stable', () => {
  const manifest = makeSyncManifest('notebook-1', 'device-1', ['head-1', 'head-1']);
  assert.deepEqual(parseSyncManifest(manifest), { ...manifest, headSnapshotIds: ['head-1'] });
  assert.deepEqual(parseSyncManifest({ ...manifest, prunedSnapshotIds: undefined }).prunedSnapshotIds, []);
});

test('legacy sync state migrates folderPath without dropping pending work', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const snapshot = makeSyncSnapshot(makeStoredDocument(notebook, 3, 'all'), state, ['parent-1']);
  state.pendingSnapshots = [snapshot];
  const { location: _location, ...legacyFields } = state;
  const legacy = {
    ...legacyFields,
    schemaVersion: LEGACY_SYNC_SCHEMA_VERSION,
    folderPath: 'C:\\Users\\Albert\\OneDrive',
  };
  const migrated = parseSyncState(legacy);
  assert.equal(migrated.schemaVersion, SYNC_SCHEMA_VERSION);
  assert.deepEqual(migrated.location, { kind: 'local-folder', parentPath: 'C:\\Users\\Albert\\OneDrive' });
  assert.deepEqual(migrated.pendingSnapshots, [snapshot]);
  assert.equal(migrated.deviceId, state.deviceId);
});

test('schema-2 state migrates to a disconnected schema-3 state without binding the old folder', () => {
  const state = makeSyncState('device-1');
  state.schemaVersion = 2;
  state.notebookId = 'notebook-1';
  state.location = { kind: 'local-folder', parentPath: 'C:\\Users\\Albert\\OneDrive' };
  state.status = 'connected';
  state.pendingSnapshots = [{
    ...makeSyncSnapshot(makeStoredDocument(notebook, 3, 'all'), state, []),
    snapshotId: 'pending-1',
  }];
  state.knownHeadSnapshotIds = ['old-head'];
  state.lastError = 'old folder error';
  const migrated = migrateSyncState(state);
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.state.schemaVersion, SYNC_SCHEMA_VERSION);
  assert.equal(migrated.state.location, null);
  assert.equal(migrated.state.status, 'disconnected');
  assert.deepEqual(migrated.state.pendingSnapshots, []);
  assert.deepEqual(migrated.state.knownHeadSnapshotIds, []);
  assert.equal(migrated.state.notebookId, 'notebook-1');
});

test('schema-3 accepts only explicit Supabase locations', () => {
  const state = makeSyncState('device-1');
  const location = { kind: 'supabase', accountId: 'user-1', projectRef: 'project-1' };
  assert.deepEqual(parseSyncState({ ...state, location, status: 'connected' }).location, location);
  assert.throws(
    () => parseSyncState({ ...state, location: { kind: 'local-folder', parentPath: 'C:\\Users\\Albert' } }),
    /retired folder location/,
  );
});

test('sync state rejects duplicate pending snapshot ids and unsupported manifests', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const snapshot = makeSyncSnapshot(makeStoredDocument(notebook, 1, 'all'), state, []);
  assert.throws(() => parseSyncState({ ...state, pendingSnapshots: [snapshot, snapshot] }), /duplicate pending snapshot ids/);
  assert.throws(() => parseSyncManifest({ ...makeSyncManifest('notebook-1', 'device-1'), protocolVersion: 99 }), /unsupported manifest/);
});

test('sync state keeps check timestamps optional for older installations', () => {
  const state = makeSyncState('device-1');
  const parsed = parseSyncState({ ...state, lastCheckedAt: undefined, lastSuccessfulCheckAt: undefined });
  assert.equal(parsed.lastCheckedAt, null);
  assert.equal(parsed.lastSuccessfulCheckAt, null);
  const checked = parseSyncState({ ...state, lastCheckedAt: '2026-09-06T00:00:00.000Z', lastSuccessfulCheckAt: '2026-09-06T00:01:00.000Z' });
  assert.equal(checked.lastCheckedAt, '2026-09-06T00:00:00.000Z');
  assert.equal(checked.lastSuccessfulCheckAt, '2026-09-06T00:01:00.000Z');
});

test('snapshot ancestry supports fast-forward and common-base lookup', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const base = { ...makeSyncSnapshot(makeStoredDocument(notebook, 1, 'all'), state, []), snapshotId: 'base' };
  const child = { ...makeSyncSnapshot(makeStoredDocument(notebook, 2, 'all'), state, ['base']), snapshotId: 'child' };
  const snapshots = new Map([[base.snapshotId, base], [child.snapshotId, child]]);
  assert.equal(hasCompleteSnapshotAncestry(child, snapshots), true);
  assert.equal(isSnapshotAncestor('base', 'child', snapshots), true);
  assert.equal(findCommonSnapshotAncestor('base', 'child', snapshots), 'base');
});

test('snapshot leaves exclude ancestors while preserving concurrent branches', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const base = { ...makeSyncSnapshot(makeStoredDocument(notebook, 1, 'all'), state, []), snapshotId: 'base', createdAt: '2026-09-06T00:00:00.000Z' };
  const firstBranch = { ...makeSyncSnapshot(makeStoredDocument(notebook, 2, 'all'), state, ['base']), snapshotId: 'first', createdAt: '2026-09-06T00:01:00.000Z' };
  const secondBranch = { ...makeSyncSnapshot(makeStoredDocument(notebook, 3, 'all'), state, ['base']), snapshotId: 'second', createdAt: '2026-09-06T00:02:00.000Z' };
  const firstDescendant = { ...makeSyncSnapshot(makeStoredDocument(notebook, 4, 'all'), state, ['first']), snapshotId: 'first-child', createdAt: '2026-09-06T00:03:00.000Z' };
  const snapshots = new Map([
    [base.snapshotId, base],
    [firstBranch.snapshotId, firstBranch],
    [secondBranch.snapshotId, secondBranch],
    [firstDescendant.snapshotId, firstDescendant],
  ]);
  assert.deepEqual(snapshotLeaves(snapshots).map(snapshot => snapshot.snapshotId), ['second', 'first-child']);
  assert.deepEqual(reconcileManifestHeadIds(snapshots, ['base', 'unknown-head']), ['second', 'first-child', 'unknown-head']);
});

test('sync snapshots can be recovered as normal local documents and reject stale descendants', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const base = { ...makeSyncSnapshot(makeStoredDocument(notebook, 36, 'all'), state, []), snapshotId: 'base' };
  const stale = { ...makeSyncSnapshot(makeStoredDocument(notebook, 34, 'all'), state, ['base']), snapshotId: 'stale' };
  const snapshots = new Map([[base.snapshotId, base], [stale.snapshotId, stale]]);
  assert.equal(hasValidSnapshotParentRevisions(stale, snapshots), false);
  assert.equal(hasValidSnapshotParentRevisions(base, snapshots), true);
  const recovered = storedDocumentFromSyncSnapshot(base, 'today', 'light');
  assert.equal(recovered.schemaVersion, 1);
  assert.equal(recovered.revision, 36);
  assert.equal(recovered.preferences.viewMode, 'today');
  assert.equal(recovered.preferences.theme, 'light');
  assert.deepEqual(recovered.categories, base.categories);
});

test('merge everything unions categories, tasks, dates, and missing values without conflicts', () => {
  const local = {
    categories: [{
      id: 'shared-category',
      name: 'Local name',
      tasks: [{ id: 'shared-task', title: 'Local title', scheduledDates: ['2026-09-10'], deadlineDate: null }],
    }, { id: 'local-category', name: 'Local only', tasks: [] }],
  };
  const remote = {
    categories: [{
      id: 'shared-category',
      name: 'Remote name',
      tasks: [
        { id: 'shared-task', title: 'Remote title', scheduledDates: ['2026-09-11'], deadlineDate: '2026-09-12' },
        { id: 'remote-task', title: 'Remote only', scheduledDates: [], deadlineDate: null },
      ],
    }, { id: 'remote-category', name: 'Remote only', tasks: [] }],
  };

  const merged = mergeEverything(local, remote);
  assert.deepEqual(merged.categories.map(category => category.id), ['shared-category', 'local-category', 'remote-category']);
  assert.deepEqual(merged.categories[0].tasks.map(task => task.id), ['shared-task', 'remote-task']);
  assert.equal(merged.categories[0].name, 'Local name');
  assert.equal(merged.categories[0].tasks[0].title, 'Local title');
  assert.deepEqual(merged.categories[0].tasks[0].scheduledDates, ['2026-09-10', '2026-09-11']);
  assert.equal(merged.categories[0].tasks[0].deadlineDate, '2026-09-12');
});

test('three-way merge keeps independent task fields and records same-field conflicts', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const baseDocument = makeStoredDocument(notebook, 1, 'all');
  const localDocument = makeStoredDocument({ categories: [{ ...notebook.categories[0], tasks: [{ ...notebook.categories[0].tasks[0], title: 'Local title' }] }] }, 2, 'all');
  const remoteDocument = makeStoredDocument({ categories: [{ ...notebook.categories[0], tasks: [{ ...notebook.categories[0].tasks[0], deadlineDate: '2026-09-12' }] }] }, 2, 'all');
  const merged = mergeNotebooks(
    { categories: baseDocument.categories },
    { categories: localDocument.categories },
    { categories: remoteDocument.categories },
    'local',
    'remote',
  );
  assert.equal(merged.conflicts.length, 0);
  assert.equal(merged.notebook.categories[0].tasks[0].title, 'Local title');
  assert.equal(merged.notebook.categories[0].tasks[0].deadlineDate, '2026-09-12');

  const conflict = mergeNotebooks(
    { categories: baseDocument.categories },
    { categories: localDocument.categories },
    { categories: { ...remoteDocument, categories: [{ ...notebook.categories[0], tasks: [{ ...notebook.categories[0].tasks[0], title: 'Remote title' }] }] }.categories },
    'local',
    'remote',
  );
  assert.equal(conflict.conflicts.length, 1);
  const resolved = applySyncConflict({ categories: conflict.notebook.categories }, conflict.conflicts[0], conflict.conflicts[0].remoteValue);
  assert.equal(resolved.categories[0].tasks[0].title, 'Remote title');
});
