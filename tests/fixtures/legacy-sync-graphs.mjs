const notebookId = 'synthetic-notebook';
const deviceId = 'synthetic-device';

function snapshot(snapshotId, revision, parentSnapshotIds = [], createdAt = `2026-01-01T00:0${revision}:00.000Z`) {
  return {
    protocolVersion: 1,
    type: parentSnapshotIds.length === 0 ? 'checkpoint' : 'snapshot',
    ...(parentSnapshotIds.length === 0 ? { checkpointVersion: 1 } : {}),
    snapshotId,
    notebookId,
    deviceId,
    parentSnapshotIds,
    createdAt,
    revision,
    categories: [{
      id: 'synthetic-category',
      name: 'Synthetic category',
      tasks: [{
        id: `synthetic-task-${snapshotId}`,
        title: `Synthetic task ${revision}`,
        scheduledDates: [],
        deadlineDate: null,
      }],
    }],
  };
}

function manifest(headSnapshotIds) {
  return {
    protocolVersion: 1,
    type: 'manifest',
    notebookId,
    createdAt: '2026-01-01T01:00:00.000Z',
    createdByDeviceId: deviceId,
    headSnapshotIds,
    prunedSnapshotIds: [],
  };
}

const oneBase = snapshot('one-base', 0);
const oneHead = snapshot('one-head', 1, ['one-base']);

const branchBase = snapshot('branch-base', 0);
const branchLeft = snapshot('branch-left', 1, ['branch-base']);
const branchRight = snapshot('branch-right', 2, ['branch-base']);

const orphanBase = snapshot('orphan-base', 0);
const listedHead = snapshot('listed-head', 1, ['orphan-base']);
const orphanHead = snapshot('orphan-head', 2, ['orphan-base']);

const brokenHead = snapshot('broken-head', 1, ['missing-parent']);

export const legacySyncGraphs = Object.freeze({
  oneHead: {
    manifest: manifest(['one-head']),
    snapshots: [oneBase, oneHead],
  },
  multipleCompleteHeads: {
    manifest: manifest(['branch-left', 'branch-right']),
    snapshots: [branchBase, branchLeft, branchRight],
  },
  orphanSnapshot: {
    manifest: manifest(['listed-head']),
    snapshots: [orphanBase, listedHead, orphanHead],
    orphanSnapshotId: 'orphan-head',
  },
  missingAncestry: {
    manifest: manifest(['broken-head']),
    snapshots: [brokenHead],
    missingSnapshotId: 'missing-parent',
  },
});
