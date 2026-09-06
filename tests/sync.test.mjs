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
  mergeNotebooks,
  parseSyncManifest,
  parseSyncSnapshot,
  parseSyncState,
  storedDocumentFromSyncSnapshot,
  syncManifestPath,
  syncRootPath,
  syncSnapshotPath,
  SYNC_CHECKPOINT_VERSION,
  SYNC_SNAPSHOT_RETENTION_LIMIT,
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

test('sync manifests and Windows folder paths are stable', () => {
  const manifest = makeSyncManifest('notebook-1', 'device-1', ['head-1', 'head-1']);
  assert.deepEqual(parseSyncManifest(manifest), { ...manifest, headSnapshotIds: ['head-1'] });
  assert.deepEqual(parseSyncManifest({ ...manifest, prunedSnapshotIds: undefined }).prunedSnapshotIds, []);
  assert.equal(syncRootPath('C:\\Users\\Albert\\OneDrive\\Backlogger'), 'C:\\Users\\Albert\\OneDrive\\Backlogger\\backlogger-sync');
  assert.equal(syncManifestPath('C:\\Users\\Albert\\OneDrive\\Backlogger'), 'C:\\Users\\Albert\\OneDrive\\Backlogger\\backlogger-sync\\notebook.json');
  assert.equal(syncSnapshotPath('C:\\Users\\Albert\\OneDrive\\Backlogger', 'snapshot-1'), 'C:\\Users\\Albert\\OneDrive\\Backlogger\\backlogger-sync\\snapshots\\snapshot-1.json');
});

test('sync state rejects duplicate pending snapshot ids and unsupported manifests', () => {
  const state = makeSyncState('device-1');
  state.notebookId = 'notebook-1';
  const snapshot = makeSyncSnapshot(makeStoredDocument(notebook, 1, 'all'), state, []);
  assert.throws(() => parseSyncState({ ...state, pendingSnapshots: [snapshot, snapshot] }), /duplicate pending snapshot ids/);
  assert.throws(() => parseSyncManifest({ ...makeSyncManifest('notebook-1', 'device-1'), protocolVersion: 99 }), /unsupported manifest/);
});

test('sync state keeps folder-check timestamps optional for older installations', () => {
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
