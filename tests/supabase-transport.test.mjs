import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseSyncTransport } from '../src/sync/supabase-transport.ts';
import { SyncTransportError } from '../src/sync/transport.ts';

const projectRef = 'project-a';
const accountId = 'user-a';

function checkpoint(notebookId, snapshotId) {
  return {
    protocolVersion: 1,
    type: 'checkpoint',
    checkpointVersion: 1,
    snapshotId,
    notebookId,
    deviceId: 'device-a',
    parentSnapshotIds: [],
    createdAt: '2026-09-10T00:00:00.000Z',
    revision: 1,
    categories: [],
  };
}

function snapshot(notebookId, snapshotId, parentSnapshotIds = []) {
  return {
    protocolVersion: 1,
    type: 'snapshot',
    snapshotId,
    notebookId,
    deviceId: 'device-a',
    parentSnapshotIds,
    createdAt: '2026-09-10T00:01:00.000Z',
    revision: 2,
    categories: [],
  };
}

function manifest(notebookId, heads) {
  return {
    protocolVersion: 1,
    type: 'manifest',
    notebookId,
    createdAt: '2026-09-10T00:00:00.000Z',
    createdByDeviceId: 'device-a',
    headSnapshotIds: heads,
    prunedSnapshotIds: [],
  };
}

function jsonEqual(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

class FakeSupabaseClient {
  constructor({ userId = accountId } = {}) {
    this.userId = userId;
    this.notebooks = [];
    this.snapshots = [];
    this.authError = null;
    this.queryError = null;
    this.rpcErrors = new Map();
    this.rangeCalls = [];
    this.auth = {
      getUser: async () => ({
        data: this.authError ? null : { user: this.userId ? { id: this.userId } : null },
        error: this.authError,
      }),
    };
  }

  from(table) {
    const client = this;
    return {
      select(columns) {
        const filters = [];
        let sortColumn = null;
        let ascending = true;
        return {
          eq(column, value) {
            filters.push([column, value]);
            return this;
          },
          order(column, options = {}) {
            sortColumn = column;
            ascending = options.ascending !== false;
            return this;
          },
          async range(from, to) {
            client.rangeCalls.push({ table, columns, from, to, filters: [...filters] });
            if (client.queryError) return { data: null, error: client.queryError };
            const source = table === 'sync_notebooks' ? client.notebooks : client.snapshots;
            let rows = source.filter(row => filters.every(([column, value]) => row[column] === value));
            if (sortColumn) {
              rows = [...rows].sort((left, right) => {
                const comparison = String(left[sortColumn]).localeCompare(String(right[sortColumn]));
                return ascending ? comparison : -comparison;
              });
            }
            return { data: rows.slice(from, to + 1), error: null };
          },
        };
      },
    };
  }

  async rpc(functionName, args) {
    const injected = this.rpcErrors.get(functionName);
    if (injected) return { data: null, error: injected };

    if (functionName === 'initialize_sync_notebook') {
      if (this.notebooks.some(row => row.owner_id === this.userId || row.notebook_id === args.p_notebook_id)) {
        return { data: null, error: { code: '23505', message: 'notebook already exists' } };
      }
      this.notebooks.push({
        owner_id: this.userId,
        notebook_id: args.p_notebook_id,
        manifest: args.p_manifest,
        manifest_version: 1,
      });
      this.snapshots.push({
        notebook_id: args.p_notebook_id,
        snapshot_id: args.p_snapshot_id,
        payload: args.p_snapshot,
      });
      return { data: [{ manifest: args.p_manifest, manifest_version: 1 }], error: null };
    }

    if (functionName === 'create_sync_snapshot') {
      const existing = this.snapshots.find(row => row.notebook_id === args.p_notebook_id && row.snapshot_id === args.p_snapshot_id);
      if (!existing) {
        this.snapshots.push({ notebook_id: args.p_notebook_id, snapshot_id: args.p_snapshot_id, payload: args.p_payload });
        return { data: [{ status: 'created', payload: args.p_payload }], error: null };
      }
      if (!jsonEqual(existing.payload, args.p_payload)) {
        return { data: null, error: { code: 'P0001', message: 'snapshot id already contains different immutable content' } };
      }
      return { data: [{ status: 'already-identical', payload: existing.payload }], error: null };
    }

    if (functionName === 'compare_and_swap_sync_manifest') {
      const row = this.notebooks.find(item => item.owner_id === this.userId && item.notebook_id === args.p_notebook_id);
      if (!row) return { data: null, error: { code: '42501', message: 'notebook is not owned by the authenticated user' } };
      if (row.manifest_version !== args.p_expected_manifest_version) {
        return { data: [{ applied: false, manifest: row.manifest, manifest_version: row.manifest_version }], error: null };
      }
      row.manifest = args.p_manifest;
      row.manifest_version += 1;
      return { data: [{ applied: true, manifest: row.manifest, manifest_version: row.manifest_version }], error: null };
    }

    if (functionName === 'delete_pruned_sync_snapshot') {
      const notebook = this.notebooks.find(row => row.owner_id === this.userId && row.notebook_id === args.p_notebook_id);
      const index = this.snapshots.findIndex(row => row.notebook_id === args.p_notebook_id && row.snapshot_id === args.p_snapshot_id);
      if (index === -1) return { data: true, error: null };
      if (!notebook.manifest.prunedSnapshotIds.includes(args.p_snapshot_id)
        || notebook.manifest.headSnapshotIds.includes(args.p_snapshot_id)) {
        return { data: null, error: { code: 'P0001', message: 'snapshot is not marked pruned or is still a head' } };
      }
      this.snapshots.splice(index, 1);
      return { data: true, error: null };
    }

    throw new Error(`Unexpected RPC ${functionName}`);
  }
}

function transport(fake, options = {}) {
  return new SupabaseSyncTransport(
    { kind: 'supabase', accountId, projectRef },
    { client: fake, projectRef, ...options },
  );
}

async function initialize(fake, notebookId = 'notebook-a', snapshotId = 'checkpoint-a') {
  const instance = transport(fake);
  await instance.initializeNotebook(
    notebookId,
    snapshotId,
    JSON.stringify(checkpoint(notebookId, snapshotId)),
    JSON.stringify(manifest(notebookId, [snapshotId])),
  );
  return { instance, notebookId, snapshotId };
}

test('initializes one notebook, returns the database manifest version, and uses CAS', async () => {
  const fake = new FakeSupabaseClient();
  const { instance, notebookId, snapshotId } = await initialize(fake);
  const remote = await instance.readManifest();
  assert.equal(remote.version, '1');
  assert.equal(JSON.parse(remote.content).headSnapshotIds[0], snapshotId);

  const updated = manifest(notebookId, ['snapshot-b']);
  const applied = await instance.writeManifest(JSON.stringify(updated), remote.version);
  assert.equal(applied.version, '2');
  await assert.rejects(
    () => instance.writeManifest(JSON.stringify(manifest(notebookId, ['snapshot-c'])), '1'),
    error => error instanceof SyncTransportError && error.code === 'conflict' && error.retriable,
  );
});

test('paginates snapshot history and reads by notebook plus snapshot id', async () => {
  const fake = new FakeSupabaseClient();
  const { instance, notebookId, snapshotId } = await initialize(fake);
  for (let index = 0; index < 5; index += 1) {
    const id = `snapshot-${index}`;
    await instance.createSnapshot(id, JSON.stringify(snapshot(notebookId, id, [snapshotId])));
  }
  const paged = transport(fake, { pageSize: 2 });
  const entries = await paged.listSnapshots();
  assert.equal(entries.length, 6);
  assert.ok(fake.rangeCalls.filter(call => call.table === 'sync_snapshots').length >= 3);
  const read = await paged.readSnapshot(entries.at(-1));
  assert.equal(JSON.parse(read.content).notebookId, notebookId);
});

test('accepts identical duplicate snapshots and rejects immutable collisions', async () => {
  const fake = new FakeSupabaseClient();
  const { instance, notebookId, snapshotId } = await initialize(fake);
  const first = JSON.stringify(snapshot(notebookId, 'duplicate', [snapshotId]));
  const second = await instance.createSnapshot('duplicate', first);
  const duplicate = await instance.createSnapshot('duplicate', first);
  assert.equal(duplicate.content, second.content);
  await assert.rejects(
    () => instance.createSnapshot('duplicate', JSON.stringify({ ...snapshot(notebookId, 'duplicate', [snapshotId]), revision: 99 })),
    error => error instanceof SyncTransportError && error.code === 'conflict' && !error.retriable,
  );
});

test('maps auth loss, RLS denial, and network failures to sanitized transport errors', async () => {
  const authLost = new FakeSupabaseClient({ userId: null });
  await assert.rejects(
    () => transport(authLost).resolveLocation(),
    error => error instanceof SyncTransportError && error.code === 'auth-required' && error.retriable,
  );

  const denied = new FakeSupabaseClient();
  denied.queryError = { status: 403, message: 'row-level security policy denied the request' };
  await assert.rejects(
    () => transport(denied).readManifest(),
    error => error instanceof SyncTransportError && error.code === 'permission' && !error.message.includes('row-level'),
  );

  const offline = new FakeSupabaseClient();
  offline.queryError = new TypeError('Failed to fetch');
  await assert.rejects(
    () => transport(offline).readManifest(),
    error => error instanceof SyncTransportError && error.code === 'offline' && error.retriable,
  );
});

test('rejects invalid JSON, invalid provider payloads, and guarded deletion', async () => {
  const fake = new FakeSupabaseClient();
  const { instance, notebookId, snapshotId } = await initialize(fake);
  await assert.rejects(
    () => instance.createSnapshot('bad', '{not json'),
    error => error instanceof SyncTransportError && error.code === 'invalid',
  );

  fake.notebooks[0].manifest = 'not-an-object';
  await assert.rejects(
    () => transport(fake).readManifest(),
    error => error instanceof SyncTransportError && error.code === 'invalid',
  );

  fake.notebooks[0].manifest = manifest(notebookId, [snapshotId]);
  await assert.rejects(
    () => instance.deleteSnapshot(snapshotId),
    error => error instanceof SyncTransportError && error.code === 'conflict' && !error.retriable,
  );

  fake.notebooks[0].manifest = manifest(notebookId, []);
  fake.notebooks[0].manifest.prunedSnapshotIds = [snapshotId];
  await instance.deleteSnapshot(snapshotId);
  await instance.deleteSnapshot(snapshotId);
});

test('rejects project/account mismatches and preserves both concurrent heads after a stale CAS', async () => {
  const fake = new FakeSupabaseClient();
  const { instance, notebookId, snapshotId } = await initialize(fake);
  assert.throws(
    () => new SupabaseSyncTransport({ kind: 'supabase', accountId, projectRef: 'project-b' }, { client: fake, projectRef }),
    error => error instanceof SyncTransportError && error.code === 'conflict',
  );

  const wrongAccount = transport(new FakeSupabaseClient({ userId: 'user-b' }));
  await assert.rejects(
    () => wrongAccount.resolveLocation(),
    error => error instanceof SyncTransportError && error.code === 'conflict',
  );

  const first = transport(fake);
  const second = transport(fake);
  const branchA = 'branch-a';
  const branchB = 'branch-b';
  await first.createSnapshot(branchA, JSON.stringify(snapshot(notebookId, branchA, [snapshotId])));
  await second.createSnapshot(branchB, JSON.stringify(snapshot(notebookId, branchB, [snapshotId])));
  const base = await first.readManifest();
  await first.writeManifest(JSON.stringify(manifest(notebookId, [branchA])), base.version);
  await assert.rejects(
    () => second.writeManifest(JSON.stringify(manifest(notebookId, [branchB])), base.version),
    error => error instanceof SyncTransportError && error.code === 'conflict' && error.retriable,
  );
  const latest = await second.readManifest();
  const preserved = await second.writeManifest(JSON.stringify(manifest(notebookId, [branchA, branchB])), latest.version);
  assert.deepEqual(JSON.parse(preserved.content).headSnapshotIds, [branchA, branchB]);
});
