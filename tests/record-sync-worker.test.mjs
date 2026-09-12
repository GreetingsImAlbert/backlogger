import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLocalRepository } from '../src/local-db/index.ts';
import { RecordSyncWorker } from '../src/sync-v2/worker.ts';
import { RecordTransportError } from '../src/sync-v2/transport.ts';

const ACCOUNT = 'account-a';
const PROJECT = 'project-a';
const NOTEBOOK = 'notebook-a';
const NOW = '2026-09-13T00:00:00.000Z';
const LATER = '2026-09-13T01:00:00.000Z';
const WORKER_NOW = '2026-09-13T02:00:00.000Z';

function binding(overrides = {}) {
  return { accountId: ACCOUNT, projectRef: PROJECT, notebookId: NOTEBOOK, ...overrides };
}

function category({
  id = 'category-a', name = 'Category', sortKey = '4000000000000000', updatedAt = NOW,
  version = 1, changeSeq = 1, deviceId = 'device-a', ownerId = ACCOUNT, notebookId = NOTEBOOK,
} = {}) {
  return {
    recordType: 'category', id, name, sortKey, updatedAt, version, deletedAt: null,
    updatedByDeviceId: deviceId,
    fieldUpdatedAt: {
      name: { at: updatedAt, deviceId },
      sortKey: { at: updatedAt, deviceId },
    },
    changeSeq, ownerId, notebookId,
  };
}

function withoutIdentity(record) {
  const { ownerId: _ownerId, notebookId: _notebookId, ...local } = record;
  return local;
}

function recordKey(record) {
  return `${record.recordType}:${record.id}`;
}

class MemoryRecordServer {
  constructor() {
    this.sequence = 0;
    this.records = new Map();
    this.changes = [];
    this.mutations = new Map();
  }

  seed(record, sequence = record.changeSeq) {
    const canonical = { ...record, changeSeq: sequence };
    this.sequence = Math.max(this.sequence, sequence);
    this.records.set(recordKey(canonical), structuredClone(canonical));
    this.changes.push({ changeSeq: sequence, record: structuredClone(canonical) });
  }

  mutate(entry) {
    const replay = this.mutations.get(entry.mutationId);
    if (replay) return structuredClone(replay);
    const current = this.records.get(`${entry.recordType}:${entry.recordId}`);
    if ((current?.version ?? 0) !== entry.expectedVersion) {
      if (!current) throw new Error('Synthetic server cannot return a missing stale row.');
      return {
        mutationId: entry.mutationId,
        outcome: 'stale',
        recordType: entry.recordType,
        record: structuredClone(current),
      };
    }
    const canonical = {
      ...structuredClone(entry.record),
      version: entry.expectedVersion + 1,
      changeSeq: ++this.sequence,
      ownerId: entry.accountId,
      notebookId: entry.notebookId,
    };
    this.records.set(recordKey(canonical), canonical);
    this.changes.push({ changeSeq: canonical.changeSeq, record: structuredClone(canonical) });
    const acknowledgement = {
      mutationId: entry.mutationId,
      outcome: 'accepted',
      recordType: entry.recordType,
      record: structuredClone(canonical),
    };
    this.mutations.set(entry.mutationId, acknowledgement);
    return structuredClone(acknowledgement);
  }
}

class MemoryRecordTransport {
  constructor(server, transportBinding = binding()) {
    this.server = server;
    this.binding = transportBinding;
    this.online = true;
    this.authenticated = true;
    this.mutationCalls = 0;
    this.pullCalls = 0;
    this.suppressPulls = 0;
    this.throwAfterAccept = false;
    this.alwaysStale = false;
    this.pages = null;
  }

  async assertAuthenticated() {
    if (!this.authenticated) throw new RecordTransportError('auth-required', 'Sign in to use cloud sync.', true);
    if (!this.online) throw new RecordTransportError('offline', 'Cloud sync is offline.', true);
  }

  async pullChanges(afterChangeSeq, limit) {
    await this.assertAuthenticated();
    this.pullCalls += 1;
    if (this.suppressPulls > 0) {
      this.suppressPulls -= 1;
      return [];
    }
    if (this.pages) return structuredClone(this.pages.shift() ?? []);
    return structuredClone(
      this.server.changes.filter(change => change.changeSeq > afterChangeSeq).slice(0, limit),
    );
  }

  async mutate(entry) {
    await this.assertAuthenticated();
    this.mutationCalls += 1;
    if (this.alwaysStale) {
      const current = this.server.records.get(`${entry.recordType}:${entry.recordId}`);
      return {
        mutationId: entry.mutationId,
        outcome: 'stale',
        recordType: entry.recordType,
        record: structuredClone(current),
      };
    }
    const acknowledgement = this.server.mutate(entry);
    if (this.throwAfterAccept) {
      this.throwAfterAccept = false;
      throw new RecordTransportError('offline', 'Acknowledgement was lost.', true);
    }
    return acknowledgement;
  }
}

function dependencies(prefix) {
  let id = 0;
  return { now: () => WORKER_NOW, createId: () => `${prefix}-${++id}` };
}

async function boundRepository(prefix, localBinding = binding()) {
  const { repository, store } = createInMemoryLocalRepository(null, dependencies(prefix));
  await repository.initialize(null);
  const state = (await repository.readModel()).syncState;
  await repository.setSyncState({
    ...state,
    ...localBinding,
    status: 'catching-up',
  });
  return { repository, store };
}

function worker(repository, transport, options = {}) {
  return new RecordSyncWorker(repository, transport, {
    pageSize: 2,
    pollIntervalMs: 60_000,
    now: () => WORKER_NOW,
    ...options,
  });
}

test('delta pull sorts pages, tolerates gaps and exact duplicates, and commits records with the cursor', async () => {
  const server = new MemoryRecordServer();
  const first = category({ id: 'category-a', changeSeq: 2 });
  const second = category({ id: 'category-b', changeSeq: 5 });
  const third = category({ id: 'category-c', changeSeq: 9 });
  server.seed(first, 2);
  server.seed(second, 5);
  server.seed(third, 9);
  const transport = new MemoryRecordTransport(server);
  transport.pages = [
    [{ changeSeq: 5, record: second }, { changeSeq: 2, record: first }],
    [{ changeSeq: 9, record: third }, { changeSeq: 9, record: third }],
    [],
  ];
  const { repository } = await boundRepository('delta');

  const result = await worker(repository, transport).runCycle();

  assert.equal(result.pulled, 3);
  assert.equal(result.lastChangeSeq, 9);
  assert.deepEqual((await repository.readModel()).records.categories.map(record => record.id).sort(), [
    'category-a', 'category-b', 'category-c',
  ]);
  assert.equal((await repository.readModel()).syncState.status, 'live');
});

test('offline failure survives restart and the same durable mutation is published later', async () => {
  const server = new MemoryRecordServer();
  const transport = new MemoryRecordTransport(server);
  const { repository, store } = await boundRepository('offline');
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.createCategory({
    id: 'category-a', name: 'Offline', sortKey: '4000000000000000', editedAt: NOW, deviceId,
  });
  const mutationId = (await repository.listOutbox())[0].mutationId;
  transport.online = false;

  await assert.rejects(worker(repository, transport).runCycle(), /offline/i);
  assert.equal((await repository.listOutbox())[0].mutationId, mutationId);
  assert.equal((await repository.listOutbox())[0].attemptCount, 0);
  assert.equal((await repository.readModel()).syncState.status, 'degraded');
  assert.match((await repository.readModel()).syncState.lastError, /offline/i);

  const { repository: reopened } = createInMemoryLocalRepository(store.inspect(), dependencies('reopened'));
  await reopened.initialize(null);
  transport.online = true;
  await worker(reopened, transport).runCycle();
  assert.equal((await reopened.listOutbox()).length, 0);
  assert.equal(server.records.get('category:category-a').name, 'Offline');
});

test('a stale mutation merges independent fields and retries with the canonical version', async () => {
  const server = new MemoryRecordServer();
  const base = category();
  server.seed(base);
  const transport = new MemoryRecordTransport(server);
  const { repository } = await boundRepository('stale');
  await repository.transaction(transaction => {
    transaction.applyServerRecord(withoutIdentity(base));
    transaction.setCursor(1);
  });
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.editCategory('category-a', { name: 'Local name', editedAt: LATER, deviceId });

  const serverEdit = category({
    sortKey: '8000000000000000', updatedAt: LATER, version: 2, changeSeq: 2, deviceId: 'device-b',
  });
  server.seed(serverEdit, 2);
  transport.suppressPulls = 1;

  const result = await worker(repository, transport).runCycle();

  assert.equal(result.staleResponses, 1);
  assert.equal(transport.mutationCalls, 2);
  assert.equal((await repository.listOutbox()).length, 0);
  const canonical = server.records.get('category:category-a');
  assert.equal(canonical.name, 'Local name');
  assert.equal(canonical.sortKey, '8000000000000000');
  assert.equal(canonical.version, 3);
});

test('an accepted server write with a lost acknowledgement is replayed without duplication', async () => {
  const server = new MemoryRecordServer();
  const transport = new MemoryRecordTransport(server);
  const { repository } = await boundRepository('ack-loss');
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.createCategory({
    id: 'category-a', name: 'Once', sortKey: '4000000000000000', editedAt: NOW, deviceId,
  });
  transport.throwAfterAccept = true;

  await assert.rejects(worker(repository, transport).runCycle(), /acknowledgement was lost/i);
  assert.equal(server.changes.length, 1);
  assert.equal((await repository.listOutbox()).length, 1);

  await worker(repository, transport).runCycle();
  assert.equal(server.changes.length, 1);
  assert.equal((await repository.listOutbox()).length, 0);
  assert.equal((await repository.readModel()).syncState.lastChangeSeq, 1);
});

test('stale retries are bounded and retain a durable error for a later cycle', async () => {
  const server = new MemoryRecordServer();
  server.seed(category({ name: 'Server' }));
  const transport = new MemoryRecordTransport(server);
  transport.alwaysStale = true;
  transport.suppressPulls = 1;
  const { repository } = await boundRepository('bounded');
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.createCategory({
    id: 'category-a', name: 'Local', sortKey: '4000000000000000', editedAt: LATER, deviceId,
  });

  await assert.rejects(worker(repository, transport, { maxStaleAttempts: 3 }).runCycle(), /retry is deferred/i);
  assert.equal(transport.mutationCalls, 3);
  assert.match((await repository.listOutbox())[0].lastError, /retry is deferred/i);
});

test('wrong local bindings and expired authentication fail without discarding local work', async () => {
  const server = new MemoryRecordServer();
  const mismatchedTransport = new MemoryRecordTransport(server, binding({ projectRef: 'project-b' }));
  const { repository } = await boundRepository('binding');
  await assert.rejects(worker(repository, mismatchedTransport).runCycle(), /binding does not match/i);

  const authTransport = new MemoryRecordTransport(server);
  authTransport.authenticated = false;
  const deviceId = (await repository.readModel()).syncState.deviceId;
  await repository.createCategory({
    id: 'category-a', name: 'Queued', sortKey: '4000000000000000', editedAt: NOW, deviceId,
  });
  await assert.rejects(worker(repository, authTransport).runCycle(), /sign in/i);
  assert.equal((await repository.listOutbox()).length, 1);
  assert.equal((await repository.readModel()).syncState.status, 'degraded');
});

test('two clients converge through polling alone without Realtime', async () => {
  const server = new MemoryRecordServer();
  const firstTransport = new MemoryRecordTransport(server);
  const secondTransport = new MemoryRecordTransport(server);
  const { repository: first } = await boundRepository('first');
  const { repository: second } = await boundRepository('second');
  const firstDevice = (await first.readModel()).syncState.deviceId;
  await first.createCategory({
    id: 'category-a', name: 'From first', sortKey: '4000000000000000', editedAt: NOW, deviceId: firstDevice,
  });

  await worker(first, firstTransport).runCycle();
  await worker(second, secondTransport).runCycle();
  const secondDevice = (await second.readModel()).syncState.deviceId;
  await second.editCategory('category-a', { name: 'From second', editedAt: LATER, deviceId: secondDevice });
  await worker(second, secondTransport).runCycle();
  await worker(first, firstTransport).runCycle();

  assert.deepEqual((await first.readModel()).notebook, (await second.readModel()).notebook);
  assert.equal((await first.readModel()).notebook.categories[0].name, 'From second');
  assert.equal((await first.listOutbox()).length, 0);
  assert.equal((await second.listOutbox()).length, 0);
});

test('overlapping foreground requests are serialized into complete pull-push-pull cycles', async () => {
  const server = new MemoryRecordServer();
  const transport = new MemoryRecordTransport(server);
  const { repository } = await boundRepository('serialized');
  const originalPull = transport.pullChanges.bind(transport);
  let activePulls = 0;
  let maximumActivePulls = 0;
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  transport.pullChanges = async (...args) => {
    activePulls += 1;
    maximumActivePulls = Math.max(maximumActivePulls, activePulls);
    if (transport.pullCalls === 0) await firstGate;
    const result = await originalPull(...args);
    activePulls -= 1;
    return result;
  };
  const syncWorker = worker(repository, transport);

  const first = syncWorker.runCycle();
  const second = syncWorker.runCycle();
  await new Promise(resolve => setTimeout(resolve, 0));
  releaseFirst();
  await Promise.all([first, second]);

  assert.equal(maximumActivePulls, 1);
  assert.equal(transport.pullCalls, 4);
});

test('successful polling stays degraded while Realtime is unavailable and recovers after resubscription', async () => {
  const server = new MemoryRecordServer();
  const transport = new MemoryRecordTransport(server);
  const { repository } = await boundRepository('realtime-state');
  const syncWorker = worker(repository, transport);

  await syncWorker.setRealtimeDegraded('Realtime connection failed.');
  await syncWorker.runCycle();
  assert.equal((await repository.readModel()).syncState.status, 'degraded');
  assert.match((await repository.readModel()).syncState.lastError, /Realtime connection failed/i);

  await syncWorker.setRealtimeDegraded(null);
  await syncWorker.runCycle();
  assert.equal((await repository.readModel()).syncState.status, 'live');
  assert.equal((await repository.readModel()).syncState.lastError, null);
});
