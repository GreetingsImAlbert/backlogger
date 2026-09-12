import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRecordTransport } from '../src/sync-v2/supabase-transport.ts';
import { RecordTransportError } from '../src/sync-v2/transport.ts';

const ACCOUNT = 'account-a';
const PROJECT = 'project-a';
const NOTEBOOK = 'notebook-a';
const NOW = '2026-09-13T00:00:00.000Z';

function binding(overrides = {}) {
  return { accountId: ACCOUNT, projectRef: PROJECT, notebookId: NOTEBOOK, ...overrides };
}

function localCategory(overrides = {}) {
  return {
    recordType: 'category',
    id: 'category-a',
    name: 'Category',
    sortKey: '4000000000000000',
    updatedAt: NOW,
    version: 0,
    deletedAt: null,
    updatedByDeviceId: 'device-a',
    fieldUpdatedAt: {
      name: { at: NOW, deviceId: 'device-a' },
      sortKey: { at: NOW, deviceId: 'device-a' },
    },
    changeSeq: 0,
    ...overrides,
  };
}

function remoteCategory(overrides = {}) {
  return {
    ...localCategory(),
    version: 1,
    changeSeq: 4,
    ownerId: ACCOUNT,
    notebookId: NOTEBOOK,
    ...overrides,
  };
}

function localTask(overrides = {}) {
  return {
    recordType: 'task',
    id: 'task-a',
    categoryId: 'category-a',
    title: 'Task',
    scheduledDates: [],
    deadlineDate: null,
    sortKey: '4000000000000000',
    updatedAt: NOW,
    version: 0,
    deletedAt: null,
    updatedByDeviceId: 'device-a',
    fieldUpdatedAt: {
      categoryId: { at: NOW, deviceId: 'device-a' },
      title: { at: NOW, deviceId: 'device-a' },
      scheduledDates: { at: NOW, deviceId: 'device-a' },
      deadlineDate: { at: NOW, deviceId: 'device-a' },
      sortKey: { at: NOW, deviceId: 'device-a' },
    },
    changeSeq: 0,
    ...overrides,
  };
}

function outboxEntry(overrides = {}) {
  return {
    recordType: 'category',
    recordId: 'category-a',
    accountId: ACCOUNT,
    projectRef: PROJECT,
    notebookId: NOTEBOOK,
    mutationId: 'mutation-a',
    expectedVersion: 0,
    record: localCategory(),
    attemptCount: 0,
    lastAttemptAt: null,
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class FakeClient {
  constructor() {
    this.userId = ACCOUNT;
    this.authError = null;
    this.rpcError = null;
    this.calls = [];
    this.changes = [];
    this.mutationResult = [{ outcome: 'accepted', record: remoteCategory() }];
    this.auth = {
      getUser: async () => ({
        data: this.authError ? null : { user: this.userId ? { id: this.userId } : null },
        error: this.authError,
      }),
    };
  }

  async rpc(name, args) {
    this.calls.push({ name, args });
    if (this.rpcError) return { data: null, error: this.rpcError };
    if (name === 'read_sync_v2_changes') return { data: structuredClone(this.changes), error: null };
    if (name === 'mutate_sync_v2_category' || name === 'mutate_sync_v2_task') {
      return { data: structuredClone(this.mutationResult), error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  }
}

function transport(client, transportBinding = binding(), projectRef = PROJECT) {
  return new SupabaseRecordTransport(transportBinding, {
    client,
    projectRef,
    now: () => Date.parse('2026-09-13T02:00:00.000Z'),
  });
}

test('Supabase record transport pulls through the ordered ledger RPC and validates canonical metadata', async () => {
  const client = new FakeClient();
  client.changes = [{
    change_seq: 4,
    record_type: 'category',
    record_id: 'category-a',
    notebook_id: NOTEBOOK,
    owner_id: ACCOUNT,
    payload: remoteCategory(),
  }];

  const changes = await transport(client).pullChanges(2, 50);

  assert.deepEqual(changes, [{ changeSeq: 4, record: remoteCategory() }]);
  assert.deepEqual(client.calls[0], {
    name: 'read_sync_v2_changes',
    args: { p_notebook_id: NOTEBOOK, p_after_seq: 2, p_limit: 50 },
  });

  client.changes[0].payload = remoteCategory({ id: 'category-b' });
  await assert.rejects(() => transport(client).pullChanges(2, 50), /mismatched record change metadata/i);
});

test('Supabase record transport routes category and task OCC mutations through their typed RPCs', async () => {
  const client = new FakeClient();
  const entry = outboxEntry();

  const acknowledgement = await transport(client).mutate(entry);

  assert.equal(acknowledgement.outcome, 'accepted');
  assert.equal(acknowledgement.record.version, 1);
  assert.deepEqual(client.calls[0], {
    name: 'mutate_sync_v2_category',
    args: {
      p_notebook_id: NOTEBOOK,
      p_category_id: 'category-a',
      p_mutation_id: 'mutation-a',
      p_expected_version: 0,
      p_payload: entry.record,
    },
  });

  const task = localTask();
  client.mutationResult = [{
    outcome: 'accepted',
    record: { ...task, version: 1, changeSeq: 5, ownerId: ACCOUNT, notebookId: NOTEBOOK },
  }];
  await transport(client).mutate(outboxEntry({
    recordType: 'task', recordId: 'task-a', mutationId: 'mutation-task', record: task,
  }));
  assert.equal(client.calls[1].name, 'mutate_sync_v2_task');
  assert.equal(client.calls[1].args.p_task_id, 'task-a');
});

test('Supabase record transport rejects project, account, and payload binding mismatches', async () => {
  const client = new FakeClient();
  assert.throws(
    () => transport(client, binding(), 'project-b'),
    error => error instanceof RecordTransportError && error.code === 'binding-mismatch',
  );

  client.userId = 'account-b';
  await assert.rejects(
    () => transport(client).pullChanges(0, 10),
    error => error instanceof RecordTransportError && error.code === 'binding-mismatch',
  );

  client.userId = ACCOUNT;
  await assert.rejects(
    () => transport(client).mutate(outboxEntry({ accountId: 'account-b' })),
    error => error instanceof RecordTransportError && error.code === 'binding-mismatch',
  );
});

test('Supabase record transport sanitizes expired authentication and network failures', async () => {
  const client = new FakeClient();
  client.authError = { status: 401, message: 'JWT expired with sensitive detail' };
  await assert.rejects(
    () => transport(client).pullChanges(0, 10),
    error => error instanceof RecordTransportError
      && error.code === 'auth-required'
      && !error.message.includes('sensitive'),
  );

  client.authError = null;
  client.rpcError = new TypeError('Failed to fetch private endpoint');
  await assert.rejects(
    () => transport(client).pullChanges(0, 10),
    error => error instanceof RecordTransportError
      && error.code === 'offline'
      && !error.message.includes('private'),
  );
});
