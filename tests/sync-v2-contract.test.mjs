import test from 'node:test';
import assert from 'node:assert/strict';
import { platformCapabilities, RECORD_SYNC_ENABLED } from '../src/platform/capabilities.ts';
import {
  parseChangeCursor,
  parseLocalSyncRecord,
  parseMutationAcknowledgement,
  parseRecordMutation,
  parseRecordSyncState,
  parseRemoteSyncRecord,
} from '../src/sync-v2/index.ts';
import {
  hasCompleteSnapshotAncestry,
  parseSyncManifest,
  parseSyncSnapshot,
  snapshotLeaves,
} from '../src/sync.ts';
import { legacySyncGraphs } from './fixtures/legacy-sync-graphs.mjs';

const now = Date.parse('2026-09-12T00:00:00.000Z');
const identity = {
  expectedNotebookId: 'notebook-1',
  expectedOwnerId: 'account-1',
  now,
};

const category = {
  recordType: 'category',
  id: 'category-1',
  name: 'Planning',
  sortKey: 'a0',
  updatedAt: '2026-09-11T10:00:00.000Z',
  version: 2,
  deletedAt: null,
  updatedByDeviceId: 'device-a',
  fieldUpdatedAt: {
    name: { at: '2026-09-11T10:00:00.000Z', deviceId: 'device-a' },
    sortKey: { at: '2026-09-10T10:00:00.000Z', deviceId: 'device-b' },
  },
  changeSeq: 7,
};

const task = {
  recordType: 'task',
  id: 'task-1',
  categoryId: 'category-1',
  title: 'Synthetic task',
  scheduledDates: ['2026-09-12', '2026-09-13'],
  deadlineDate: '2026-09-14',
  sortKey: 'a0',
  updatedAt: '2026-09-11T10:00:00.000Z',
  version: 0,
  deletedAt: null,
  updatedByDeviceId: 'device-a',
  fieldUpdatedAt: {
    categoryId: { at: '2026-09-10T10:00:00.000Z', deviceId: 'device-a' },
    title: { at: '2026-09-11T10:00:00.000Z', deviceId: 'device-a' },
    scheduledDates: { at: '2026-09-09T10:00:00.000Z', deviceId: 'device-a' },
    deadlineDate: { at: '2026-09-08T10:00:00.000Z', deviceId: 'device-a' },
    sortKey: { at: '2026-09-07T10:00:00.000Z', deviceId: 'device-a' },
  },
  changeSeq: 0,
};

test('local and remote record contracts validate and clone their mutable values', () => {
  const local = parseLocalSyncRecord(task, { now });
  assert.deepEqual(local, task);
  assert.notEqual(local.scheduledDates, task.scheduledDates);

  const remote = parseRemoteSyncRecord({ ...category, notebookId: 'notebook-1', ownerId: 'account-1' }, identity);
  assert.equal(remote.ownerId, 'account-1');
  assert.equal(remote.notebookId, 'notebook-1');
});

test('record validators reject unknown types, invalid dates and invalid versions', () => {
  assert.throws(() => parseLocalSyncRecord({ ...task, recordType: 'note' }, { now }), /unknown record type/);
  assert.throws(() => parseLocalSyncRecord({ ...task, deadlineDate: '2026-02-30' }, { now }), /valid YYYY-MM-DD/);
  assert.throws(() => parseLocalSyncRecord({ ...task, scheduledDates: ['2026-09-13', '2026-09-12'] }, { now }), /ascending order/);
  assert.throws(() => parseLocalSyncRecord({ ...task, version: -1 }, { now }), /nonnegative/);
  assert.throws(
    () => parseRemoteSyncRecord({ ...category, version: 0, notebookId: 'notebook-1', ownerId: 'account-1' }, identity),
    /must be positive/,
  );
});

test('record validators reject future clocks and malformed field-clock keys', () => {
  const futureAt = '2026-09-12T00:05:00.001Z';
  assert.throws(
    () => parseLocalSyncRecord({
      ...category,
      updatedAt: futureAt,
      fieldUpdatedAt: { ...category.fieldUpdatedAt, name: { at: futureAt, deviceId: 'device-a' } },
    }, { now }),
    /too far in the future/,
  );
  assert.throws(
    () => parseLocalSyncRecord({ ...category, fieldUpdatedAt: { name: category.fieldUpdatedAt.name } }, { now }),
    /missing its sortKey field/,
  );
  assert.throws(
    () => parseLocalSyncRecord({
      ...category,
      fieldUpdatedAt: { ...category.fieldUpdatedAt, title: category.fieldUpdatedAt.name },
    }, { now }),
    /unsupported title field/,
  );
});

test('remote validation rejects records bound to another notebook or account', () => {
  const remote = { ...category, notebookId: 'notebook-1', ownerId: 'account-1' };
  assert.throws(
    () => parseRemoteSyncRecord(remote, { ...identity, expectedNotebookId: 'notebook-2' }),
    /wrong notebook/,
  );
  assert.throws(
    () => parseRemoteSyncRecord(remote, { ...identity, expectedOwnerId: 'account-2' }),
    /wrong account/,
  );
});

test('mutation, acknowledgement, cursor and sync-state envelopes share the record contract', () => {
  const mutation = parseRecordMutation({
    mutationId: 'mutation-1',
    recordType: 'task',
    notebookId: 'notebook-1',
    ownerId: 'account-1',
    expectedVersion: 0,
    queuedAt: '2026-09-11T10:01:00.000Z',
    record: task,
  }, identity);
  assert.equal(mutation.record.id, 'task-1');

  const acknowledgement = parseMutationAcknowledgement({
    mutationId: 'mutation-1',
    outcome: 'accepted',
    recordType: 'task',
    record: { ...task, version: 1, changeSeq: 8, notebookId: 'notebook-1', ownerId: 'account-1' },
  }, identity);
  assert.equal(acknowledgement.outcome, 'accepted');
  assert.deepEqual(parseChangeCursor({ lastChangeSeq: 8 }), { lastChangeSeq: 8 });

  const state = parseRecordSyncState({
    schemaVersion: 1,
    deviceId: 'device-a',
    accountId: 'account-1',
    projectRef: 'project-1',
    notebookId: 'notebook-1',
    lastChangeSeq: 8,
    status: 'live',
    lastError: null,
  }, {
    expectedAccountId: 'account-1',
    expectedProjectRef: 'project-1',
    expectedNotebookId: 'notebook-1',
  });
  assert.equal(state.status, 'live');
});

test('legacy fixtures cover complete, concurrent, orphaned and incomplete graphs', () => {
  const parseGraph = fixture => {
    const manifest = parseSyncManifest(fixture.manifest);
    const snapshots = new Map(
      fixture.snapshots.map(value => {
        const parsed = parseSyncSnapshot(value);
        return [parsed.snapshotId, parsed];
      }),
    );
    return { manifest, snapshots };
  };

  const oneHead = parseGraph(legacySyncGraphs.oneHead);
  assert.deepEqual(snapshotLeaves(oneHead.snapshots).map(value => value.snapshotId), ['one-head']);
  assert.equal(hasCompleteSnapshotAncestry(oneHead.snapshots.get('one-head'), oneHead.snapshots), true);

  const branches = parseGraph(legacySyncGraphs.multipleCompleteHeads);
  assert.deepEqual(snapshotLeaves(branches.snapshots).map(value => value.snapshotId), ['branch-left', 'branch-right']);
  assert.deepEqual(branches.manifest.headSnapshotIds, ['branch-left', 'branch-right']);

  const orphan = parseGraph(legacySyncGraphs.orphanSnapshot);
  assert.equal(orphan.manifest.headSnapshotIds.includes(legacySyncGraphs.orphanSnapshot.orphanSnapshotId), false);
  assert.deepEqual(snapshotLeaves(orphan.snapshots).map(value => value.snapshotId), ['listed-head', 'orphan-head']);

  const incomplete = parseGraph(legacySyncGraphs.missingAncestry);
  const brokenHead = incomplete.snapshots.get('broken-head');
  assert.equal(hasCompleteSnapshotAncestry(brokenHead, incomplete.snapshots), false);
  assert.equal(incomplete.snapshots.has(legacySyncGraphs.missingAncestry.missingSnapshotId), false);
});

test('record sync is enabled for the Windows cutover but remains unavailable in browser preview', () => {
  assert.equal(RECORD_SYNC_ENABLED, true);
  assert.equal(platformCapabilities().recordSync, false);
});
