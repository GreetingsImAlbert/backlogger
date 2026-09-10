import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStoredDocument } from '../src/storage.ts';
import { SyncCoordinator } from '../src/sync/coordinator.ts';
import { makeSyncManifest, makeSyncSnapshot, makeSyncState } from '../src/sync.ts';
import { SyncTransportError } from '../src/sync/transport.ts';

function versionOf(content) {
  return `${content.length}:${content}`;
}

class MemoryTransport {
  kind = 'supabase';
  location;
  capabilities = {
    conditionalManifestWrite: 'strong',
    immutableSnapshotCreate: 'strong',
    snapshotDeletion: 'strong',
  };

  constructor(sharedFiles, name) {
    this.sharedFiles = sharedFiles;
    this.location = { kind: 'supabase', accountId: 'test-account', projectRef: name };
  }

  async resolveLocation() {
    return { location: this.location, transportId: this.location.projectRef, displayPath: this.location.projectRef };
  }

  async connect() {
    return this.resolveLocation();
  }

  async readManifest() {
    const content = this.sharedFiles.get('notebook.json');
    if (content === undefined) return null;
    const version = versionOf(content);
    return { entry: { id: 'notebook.json', displayName: 'notebook.json', kind: 'file', version }, content, version };
  }

  async writeManifest(content, expectedVersion) {
    const current = await this.readManifest();
    if (expectedVersion !== undefined && (current?.version ?? null) !== expectedVersion) {
      throw new SyncTransportError('conflict', 'manifest changed', true);
    }
    this.sharedFiles.set('notebook.json', content);
    const version = versionOf(content);
    return { entry: { id: 'notebook.json', displayName: 'notebook.json', kind: 'file', version }, content, version };
  }

  async listSnapshots() {
    return [...this.sharedFiles.keys()]
      .filter(key => key.startsWith('snapshots/'))
      .map(id => ({ id, displayName: id.slice('snapshots/'.length), kind: 'file', version: null }));
  }

  async readSnapshot(entry) {
    const content = this.sharedFiles.get(entry.id);
    if (content === undefined) throw new SyncTransportError('not-found', 'snapshot disappeared', true);
    const version = versionOf(content);
    return { entry: { ...entry, version }, content, version };
  }

  async createSnapshot(snapshotId, content) {
    const id = `snapshots/${snapshotId}.json`;
    const existing = this.sharedFiles.get(id);
    if (existing !== undefined && existing !== content) throw new SyncTransportError('conflict', 'snapshot differs', false);
    this.sharedFiles.set(id, content);
    const version = versionOf(content);
    return { entry: { id, displayName: `${snapshotId}.json`, kind: 'file', version }, content, version };
  }

  async deleteSnapshot(snapshotId) {
    this.sharedFiles.delete(`snapshots/${snapshotId}.json`);
  }
}

class StaleOnceTransport extends MemoryTransport {
  injected = false;
  writeAttempts = 0;

  async writeManifest(content, expectedVersion) {
    this.writeAttempts += 1;
    if (!this.injected && expectedVersion !== null && expectedVersion !== undefined) {
      this.injected = true;
      const current = JSON.parse(this.sharedFiles.get('notebook.json'));
      this.sharedFiles.set('notebook.json', JSON.stringify({
        ...current,
        headSnapshotIds: [...new Set([...current.headSnapshotIds, 'concurrent'])],
      }));
      throw new SyncTransportError('conflict', 'manifest changed', true);
    }
    return super.writeManifest(content, expectedVersion);
  }
}

test('coordinator keeps transport metadata separate from validated sync records', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const first = new SyncCoordinator(new MemoryTransport(sharedFiles, 'profile-a'), state.notebookId);
  const manifest = makeSyncManifest(state.notebookId, state.deviceId);
  const manifestResource = await first.writeManifest(manifest, null);
  const snapshot = makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []);
  await first.createSnapshotIfNeeded(snapshot);

  const second = new SyncCoordinator(new MemoryTransport(sharedFiles, 'profile-b'), state.notebookId);
  const remoteManifest = await second.readManifestResource();
  assert.equal(remoteManifest.manifest.notebookId, state.notebookId);
  assert.equal(remoteManifest.remote.version, manifestResource.remote.version);
  const snapshots = await second.readSnapshotIndex();
  assert.deepEqual([...snapshots.keys()], [snapshot.snapshotId]);
  await assert.rejects(
    () => first.writeManifest({ ...manifest, headSnapshotIds: [snapshot.snapshotId] }, 'stale-version'),
    error => error instanceof SyncTransportError && error.code === 'conflict',
  );
});

test('coordinator preserves the transport receiver during atomic notebook initialization', async () => {
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const snapshot = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), type: 'checkpoint', checkpointVersion: 1 };
  const manifest = makeSyncManifest(state.notebookId, state.deviceId, [snapshot.snapshotId]);
  const transport = new MemoryTransport(new Map(), 'profile-a');
  transport.initializeNotebook = async function (notebookId, snapshotId, snapshotContent, manifestContent) {
    assert.equal(this, transport);
    assert.equal(notebookId, state.notebookId);
    await this.createSnapshot(snapshotId, snapshotContent);
    return this.writeManifest(manifestContent, null);
  };

  const initialized = await new SyncCoordinator(transport).initializeNotebook(snapshot, manifest);
  assert.deepEqual(initialized.manifest.headSnapshotIds, [snapshot.snapshotId]);
});

test('coordinator publication replaces ancestor manifest entries with actual branch heads', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const coordinator = new SyncCoordinator(new MemoryTransport(sharedFiles, 'profile-a'), state.notebookId);
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), snapshotId: 'base', createdAt: '2026-09-06T00:00:00.000Z' };
  const first = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'first', createdAt: '2026-09-06T00:01:00.000Z' };
  const concurrent = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'concurrent', createdAt: '2026-09-06T00:02:00.000Z' };
  const descendant = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 3, 'all'), state, ['first']), snapshotId: 'descendant', createdAt: '2026-09-06T00:03:00.000Z' };
  await coordinator.writeManifest(makeSyncManifest(state.notebookId, state.deviceId, ['base', 'first', 'concurrent']), null);
  await coordinator.createSnapshotIfNeeded(base);
  await coordinator.createSnapshotIfNeeded(first);
  await coordinator.createSnapshotIfNeeded(concurrent);

  const published = await coordinator.publishSnapshot(descendant);

  assert.deepEqual(published.manifest.headSnapshotIds, ['concurrent', 'descendant']);
  assert.ok(sharedFiles.has('snapshots/descendant.json'));
});

test('coordinator retries a stale CAS and preserves a concurrent head', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const transport = new StaleOnceTransport(sharedFiles, 'profile-a');
  const coordinator = new SyncCoordinator(transport, state.notebookId, {
    retryDelayMs: 0,
    wait: async () => {},
  });
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), snapshotId: 'base' };
  const concurrent = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'concurrent' };
  const pending = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'pending' };
  await coordinator.writeManifest(makeSyncManifest(state.notebookId, state.deviceId, ['base']), null);
  await coordinator.createSnapshotIfNeeded(base);
  await coordinator.createSnapshotIfNeeded(concurrent);

  const published = await coordinator.publishSnapshot(pending);

  assert.equal(transport.writeAttempts, 3);
  assert.deepEqual(new Set(published.manifest.headSnapshotIds), new Set(['concurrent', 'pending']));
  assert.ok(sharedFiles.has('snapshots/pending.json'));
});

test('coordinator stops after three stale CAS attempts without losing the immutable snapshot', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const transport = new MemoryTransport(sharedFiles, 'profile-a');
  const originalWrite = transport.writeManifest.bind(transport);
  let attempts = 0;
  transport.writeManifest = async (content, expectedVersion) => {
    if (expectedVersion !== null && expectedVersion !== undefined) {
      attempts += 1;
      throw new SyncTransportError('conflict', 'manifest changed', true);
    }
    return originalWrite(content, expectedVersion);
  };
  const coordinator = new SyncCoordinator(transport, state.notebookId, {
    retryDelayMs: 0,
    wait: async () => {},
  });
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), snapshotId: 'base' };
  const pending = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'pending' };
  await coordinator.writeManifest(makeSyncManifest(state.notebookId, state.deviceId, ['base']), null);
  await coordinator.createSnapshotIfNeeded(base);

  await assert.rejects(
    () => coordinator.publishSnapshot(pending),
    error => error instanceof SyncTransportError && error.code === 'conflict' && error.retriable,
  );
  assert.equal(attempts, 3);
  assert.ok(sharedFiles.has('snapshots/pending.json'));
});

test('publication interrupted before snapshot creation leaves the remote manifest unchanged', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const transport = new MemoryTransport(sharedFiles, 'profile-a');
  const coordinator = new SyncCoordinator(transport, state.notebookId);
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), snapshotId: 'base' };
  const pending = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'pending' };
  await coordinator.writeManifest(makeSyncManifest(state.notebookId, state.deviceId, ['base']), null);
  await coordinator.createSnapshotIfNeeded(base);
  const manifestBefore = sharedFiles.get('notebook.json');
  transport.createSnapshot = async () => { throw new SyncTransportError('offline', 'interrupted', true); };

  await assert.rejects(() => coordinator.publishSnapshot(pending), /interrupted/);
  assert.equal(sharedFiles.has('snapshots/pending.json'), false);
  assert.equal(sharedFiles.get('notebook.json'), manifestBefore);
});

test('publication resumes idempotently after snapshot creation but before manifest CAS', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const transport = new MemoryTransport(sharedFiles, 'profile-a');
  const coordinator = new SyncCoordinator(transport, state.notebookId);
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), snapshotId: 'base' };
  const pending = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'pending' };
  await coordinator.writeManifest(makeSyncManifest(state.notebookId, state.deviceId, ['base']), null);
  await coordinator.createSnapshotIfNeeded(base);
  const writeManifest = transport.writeManifest.bind(transport);
  transport.writeManifest = async () => { throw new SyncTransportError('offline', 'interrupted after snapshot', true); };

  await assert.rejects(() => coordinator.publishSnapshot(pending), /interrupted after snapshot/);
  assert.ok(sharedFiles.has('snapshots/pending.json'));
  assert.deepEqual(JSON.parse(sharedFiles.get('notebook.json')).headSnapshotIds, ['base']);

  transport.writeManifest = writeManifest;
  const recovered = await coordinator.publishSnapshot(pending);
  assert.deepEqual(recovered.manifest.headSnapshotIds, ['pending']);
  assert.equal([...sharedFiles.keys()].filter(key => key === 'snapshots/pending.json').length, 1);
});

test('a stale local pending snapshot is safe to republish after manifest CAS', async () => {
  const sharedFiles = new Map();
  const state = makeSyncState('device-a');
  state.notebookId = 'notebook-1';
  const coordinator = new SyncCoordinator(new MemoryTransport(sharedFiles, 'profile-a'), state.notebookId);
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), state, []), snapshotId: 'base' };
  const pending = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), state, ['base']), snapshotId: 'pending' };
  await coordinator.writeManifest(makeSyncManifest(state.notebookId, state.deviceId, ['base']), null);
  await coordinator.createSnapshotIfNeeded(base);
  await coordinator.publishSnapshot(pending);

  const recovered = await coordinator.publishSnapshot(pending);
  assert.deepEqual(recovered.manifest.headSnapshotIds, ['pending']);
  assert.equal([...sharedFiles.keys()].filter(key => key === 'snapshots/pending.json').length, 1);
});

test('two isolated coordinators converge through sequential publications', async () => {
  const sharedFiles = new Map();
  const firstState = makeSyncState('device-a');
  const secondState = makeSyncState('device-b');
  firstState.notebookId = secondState.notebookId = 'notebook-1';
  const first = new SyncCoordinator(new MemoryTransport(sharedFiles, 'profile-a'), firstState.notebookId);
  const second = new SyncCoordinator(new MemoryTransport(sharedFiles, 'profile-b'), secondState.notebookId);
  const base = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 1, 'all'), firstState, []), snapshotId: 'base' };
  const fromFirst = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 2, 'all'), firstState, ['base']), snapshotId: 'from-first' };
  const fromSecond = { ...makeSyncSnapshot(makeStoredDocument({ categories: [] }, 3, 'all'), secondState, ['from-first']), snapshotId: 'from-second' };
  await first.writeManifest(makeSyncManifest(firstState.notebookId, firstState.deviceId, ['base']), null);
  await first.createSnapshotIfNeeded(base);
  await first.publishSnapshot(fromFirst);
  await second.publishSnapshot(fromSecond);

  const firstView = await first.readManifest();
  const secondView = await second.readManifest();
  assert.deepEqual(firstView.headSnapshotIds, ['from-second']);
  assert.deepEqual(secondView, firstView);
  assert.equal((await first.readSnapshotIndex()).size, 3);
});
