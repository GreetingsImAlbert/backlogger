import { hasValidSnapshotParentRevisions, parseSyncManifest, parseSyncSnapshot, reconcileManifestHeadIds, type SyncManifest, type SyncSnapshot } from '../sync.ts';
import { SyncTransportError, type SyncTransport, type VersionedRemoteFile } from './transport.ts';

export interface SyncManifestResource {
  manifest: SyncManifest;
  remote: VersionedRemoteFile;
}

export interface SyncSnapshotResource {
  snapshot: SyncSnapshot;
  remote: VersionedRemoteFile;
}

export interface SyncCoordinatorOptions {
  /** Maximum number of manifest CAS attempts for one immutable snapshot. */
  maxPublishAttempts?: number;
  /** Base delay before a retry. A small random jitter avoids synchronized retries. */
  retryDelayMs?: number;
  /** Injectable wait function for deterministic tests. */
  wait?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_MAX_PUBLISH_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 25;

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

/** Shared protocol adapter: transport bytes enter here, validated records leave here. */
export class SyncCoordinator {
  readonly transport: SyncTransport;
  readonly notebookId: string | null;
  private readonly maxPublishAttempts: number;
  private readonly retryDelayMs: number;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(transport: SyncTransport, notebookId: string | null = null, options: SyncCoordinatorOptions = {}) {
    this.transport = transport;
    this.notebookId = notebookId;
    this.maxPublishAttempts = Number.isInteger(options.maxPublishAttempts) && (options.maxPublishAttempts ?? 0) > 0
      ? options.maxPublishAttempts as number
      : DEFAULT_MAX_PUBLISH_ATTEMPTS;
    this.retryDelayMs = Number.isFinite(options.retryDelayMs) && (options.retryDelayMs ?? 0) >= 0
      ? options.retryDelayMs as number
      : DEFAULT_RETRY_DELAY_MS;
    this.wait = options.wait ?? defaultWait;
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

  async initializeNotebook(snapshot: SyncSnapshot, manifest: SyncManifest): Promise<SyncManifestResource> {
    if (!this.transport.initializeNotebook) throw new SyncTransportError('unsupported', 'This sync provider cannot initialize a notebook atomically.', false);
    if (snapshot.notebookId !== manifest.notebookId) throw new Error('The initial snapshot and manifest belong to different notebooks.');
    const remote = await this.transport.initializeNotebook(
      snapshot.notebookId,
      snapshot.snapshotId,
      JSON.stringify(snapshot, null, 2),
      JSON.stringify(manifest, null, 2),
    );
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

  async publishSnapshot(snapshot: SyncSnapshot): Promise<SyncManifestResource> {
    for (let attempt = 1; attempt <= this.maxPublishAttempts; attempt += 1) {
      try {
        return await this.publishSnapshotAttempt(snapshot);
      } catch (error) {
        const retryableConflict = error instanceof SyncTransportError
          && error.code === 'conflict'
          && error.retriable;
        if (!retryableConflict || attempt >= this.maxPublishAttempts) throw error;
        const jitter = this.retryDelayMs === 0 ? 0 : this.retryDelayMs * (0.5 + Math.random());
        await this.wait(jitter);
      }
    }
    throw new Error('Cloud publication stopped before a safe manifest update.');
  }

  private async publishSnapshotAttempt(snapshot: SyncSnapshot): Promise<SyncManifestResource> {
    const originalResource = await this.readManifestResource();
    const originalManifest = originalResource?.manifest ?? null;
    if (!originalManifest || !originalResource) throw new Error('The connected sync location is missing its notebook manifest.');
    if (originalManifest.notebookId !== snapshot.notebookId || (this.notebookId && this.notebookId !== snapshot.notebookId)) {
      throw new Error('The connected sync location belongs to a different notebook.');
    }

    let availableSnapshots = await this.readSnapshotIndex(new Set(originalManifest.prunedSnapshotIds), snapshot.notebookId);
    const missingParent = snapshot.parentSnapshotIds.find(parentId => !availableSnapshots.has(parentId));
    if (missingParent) {
      throw new Error(`The pending snapshot is based on history that is no longer available (${missingParent}). Fetch the shared checkpoint before publishing local work.`);
    }

    await this.createSnapshotIfNeeded(snapshot);
    const latestResource = await this.readManifestResource();
    const latestManifest = latestResource?.manifest ?? null;
    if (!latestManifest || !latestResource || latestManifest.notebookId !== snapshot.notebookId) {
      throw new Error('The notebook manifest changed while publishing.');
    }
    // Always re-read the complete visible history after the immutable insert.
    // A concurrent publisher may have added a head without changing the
    // manifest's pruned list; ancestry must be computed from that fresh set.
    availableSnapshots = await this.readSnapshotIndex(new Set(latestManifest.prunedSnapshotIds), snapshot.notebookId);
    availableSnapshots.set(snapshot.snapshotId, snapshot);
    return this.writeManifest({
      ...latestManifest,
      headSnapshotIds: reconcileManifestHeadIds(availableSnapshots, latestManifest.headSnapshotIds),
    }, latestResource.remote.version);
  }

  deleteSnapshot(snapshotId: string): Promise<void> {
    return this.transport.deleteSnapshot(snapshotId);
  }
}
