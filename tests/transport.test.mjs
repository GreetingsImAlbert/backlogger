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
  kind = 'local-folder';
  location;
  capabilities = {
    conditionalManifestWrite: 'strong',
    immutableSnapshotCreate: 'strong',
    snapshotDeletion: 'strong',
  };

  constructor(sharedFiles, name) {
    this.sharedFiles = sharedFiles;
    this.location = { kind: 'local-folder', parentPath: name };
  }

  async resolveLocation() {
    return { location: this.location, transportId: this.location.parentPath, displayPath: this.location.parentPath };
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
