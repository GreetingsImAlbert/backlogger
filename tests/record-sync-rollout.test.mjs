import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRecordSyncProtocol } from '../src/sync-v2/rollout.ts';
import { presentRecordSyncStatus } from '../src/sync-v2/status.ts';

function state(status, lastError = null) {
  return {
    schemaVersion: 1, deviceId: 'device-a', accountId: 'account-a', projectRef: 'project-a',
    notebookId: 'notebook-a', lastChangeSeq: 0, status, lastError,
  };
}

test('record sync defaults to v2 and an explicit or malformed rollback value selects legacy', () => {
  assert.equal(resolveRecordSyncProtocol(undefined), 'v2');
  assert.equal(resolveRecordSyncProtocol('v2'), 'v2');
  assert.equal(resolveRecordSyncProtocol('legacy'), 'legacy');
  assert.equal(resolveRecordSyncProtocol('typo'), 'legacy');
});

test('record sync status stays concise while details retain the actionable cause', () => {
  assert.deepEqual(presentRecordSyncStatus(state('catching-up'), 0, true), {
    label: 'Syncing…', detail: 'Reconciling local and cloud record changes.',
  });
  assert.equal(presentRecordSyncStatus(state('degraded', 'Cloud sync is offline.'), 2, true).label, 'Offline');
  assert.equal(presentRecordSyncStatus(state('error', 'The server rejected this record.'), 1, true).label, 'Sync failed');
  assert.match(presentRecordSyncStatus(state('paused'), 2, true).detail, /2 local changes/);
  assert.equal(presentRecordSyncStatus(state('live'), 0, true).label, 'Connected');
  assert.equal(presentRecordSyncStatus(state('live'), 0, false).label, 'Not logged in');
});
