import { hasValidSnapshotParentRevisions, parseSyncManifest, parseSyncSnapshot, type SyncManifest, type SyncSnapshot } from '../sync.ts';
import { SyncTransportError, type SyncTransport, type VersionedRemoteFile } from './transport.ts';

export interface SyncManifestResource {
  manifest: SyncManifest;
  remote: VersionedRemoteFile;
}

export interface SyncSnapshotResource {
  snapshot: SyncSnapshot;
  remote: VersionedRemoteFile;
}

/** Shared protocol adapter: transport bytes enter here, validated records leave here. */
export class SyncCoordinator {
  readonly transport: SyncTransport;
  readonly notebookId: string | null;

  constructor(transport: SyncTransport, notebookId: string | null = null) {
    this.transport = transport;
    this.notebookId = notebookId;
  }

  resolveLocation() {
    return this.transport.resolveLocation();
  }

  connect() {
    return this.transport.connect();
  }

  async readManifestResource(): Promise<SyncManifestResource | null> {
    const remote = await this.transport.readManifest();
    if (!remote) return null;
    try {
      return { manifest: parseSyncManifest(JSON.parse(remote.content) as unknown), remote };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`The selected sync location has an invalid notebook manifest: ${message}`);
    }
  }

  async readManifest(): Promise<SyncManifest | null> {
    const resource = await this.readManifestResource();
    return resource?.manifest ?? null;
  }

  async writeManifest(manifest: SyncManifest, expectedVersion?: string | null): Promise<SyncManifestResource> {
    const remote = await this.transport.writeManifest(JSON.stringify(manifest, null, 2), expectedVersion);
    return { manifest, remote };
  }

  async readSnapshotIndex(excludedSnapshotIds = new Set<string>(), expectedNotebookId = this.notebookId): Promise<Map<string, SyncSnapshot>> {
    const snapshots = new Map<string, SyncSnapshot>();
    const entries = await this.transport.listSnapshots();
    for (const entry of entries) {
      let remote: VersionedRemoteFile;
      try {
        remote = await this.transport.readSnapshot(entry);
      } catch (error) {
        // A provider can expose a file that disappears between listing and reading.
        if (error instanceof SyncTransportError && error.code === 'not-found') continue;
        throw error;
      }
      let snapshot: SyncSnapshot;
      try {
        snapshot = parseSyncSnapshot(JSON.parse(remote.content) as unknown, `Snapshot ${entry.displayName}`);
      } catch {
        // Partial or malformed provider files wait for a later scan.
        continue;
      }
      if (expectedNotebookId && snapshot.notebookId !== expectedNotebookId) {
        throw new Error(`Snapshot ${entry.displayName} belongs to a different notebook.`);
      }
      const existing = snapshots.get(snapshot.snapshotId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
        throw new Error(`Snapshot ${snapshot.snapshotId} has conflicting copies.`);
      }
      snapshots.set(snapshot.snapshotId, snapshot);
    }
    for (const [snapshotId, snapshot] of snapshots) {
      if (!hasValidSnapshotParentRevisions(snapshot, snapshots)) snapshots.delete(snapshotId);
    }
    excludedSnapshotIds.forEach(snapshotId => snapshots.delete(snapshotId));
    return snapshots;
  }

  async createSnapshotIfNeeded(snapshot: SyncSnapshot): Promise<SyncSnapshotResource> {
    const remote = await this.transport.createSnapshot(snapshot.snapshotId, JSON.stringify(snapshot, null, 2));
    return { snapshot, remote };
  }

  deleteSnapshot(snapshotId: string): Promise<void> {
    return this.transport.deleteSnapshot(snapshotId);
  }
}
