import { invoke } from '@tauri-apps/api/core';
import type { LocalFolderLocation } from '../sync.ts';
import { SyncTransportError, type ResolvedSyncLocation, type SyncRemoteEntry, type SyncTransport, type SyncTransportCapabilities, type VersionedRemoteFile } from './transport.ts';

export type LocalFolderSyncProfile = 'production' | 'debug';

export interface LocalFolderTransportOptions {
  profile?: LocalFolderSyncProfile;
  /** In debug profile this is the exchange root itself, not its parent. */
  exchangeRootOverride?: string;
}

function joinPath(root: string, ...parts: string[]): string {
  const separator = root.includes('\\') ? '\\' : '/';
  return [root.replace(/[\\/]+$/, ''), ...parts].join(separator);
}

export function syncRootPath(parentPath: string): string {
  return joinPath(parentPath, 'backlogger-sync');
}

export function syncSnapshotsPath(parentPath: string, exchangeRootOverride?: string): string {
  return joinPath(exchangeRootOverride ?? syncRootPath(parentPath), 'snapshots');
}

export function syncManifestPath(parentPath: string, exchangeRootOverride?: string): string {
  return joinPath(exchangeRootOverride ?? syncRootPath(parentPath), 'notebook.json');
}

export function syncSnapshotPath(parentPath: string, snapshotId: string, exchangeRootOverride?: string): string {
  return joinPath(syncSnapshotsPath(parentPath, exchangeRootOverride), `${snapshotId}.json`);
}

function versionForContent(content: string): string {
  // FNV-1a is only a local best-effort version marker, not a security hash.
  let hash = 2166136261;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
}

function equivalentJson(first: string, second: string): boolean {
  try {
    return JSON.stringify(JSON.parse(first)) === JSON.stringify(JSON.parse(second));
  } catch {
    return false;
  }
}

function safeSnapshotId(snapshotId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(snapshotId)) {
    throw new SyncTransportError('invalid', 'The snapshot id contains an unsafe filename.', false);
  }
}

function displayName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function fileEntry(path: string, version: string | null = null): SyncRemoteEntry {
  return { id: path, displayName: displayName(path), kind: 'file', version };
}

function transportError(error: unknown, operation: string): SyncTransportError {
  if (error instanceof SyncTransportError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SyncTransportError('location-unavailable', `Could not ${operation}: ${message}`, true);
}

export class LocalFolderSyncTransport implements SyncTransport {
  readonly kind = 'local-folder' as const;
  readonly location: LocalFolderLocation;
  readonly capabilities: SyncTransportCapabilities = {
    conditionalManifestWrite: 'best-effort',
    immutableSnapshotCreate: 'best-effort',
    snapshotDeletion: 'best-effort',
  };
  private readonly exchangeRoot: string;

  constructor(location: LocalFolderLocation, options: LocalFolderTransportOptions = {}) {
    const parentPath = location.parentPath.trim();
    if (!parentPath) throw new SyncTransportError('invalid', 'Choose a local sync parent folder first.', false);
    this.location = { kind: 'local-folder', parentPath };
    if (options.profile === 'debug') {
      const override = options.exchangeRootOverride?.trim();
      if (!override) throw new SyncTransportError('invalid', 'The debug sync profile requires an explicit exchange root.', false);
      this.exchangeRoot = override.replace(/[\\/]+$/, '');
    } else {
      this.exchangeRoot = syncRootPath(parentPath);
    }
  }

  private snapshotsDirectory(): string {
    return joinPath(this.exchangeRoot, 'snapshots');
  }

  private manifestPath(): string {
    return joinPath(this.exchangeRoot, 'notebook.json');
  }

  private snapshotPath(snapshotId: string): string {
    safeSnapshotId(snapshotId);
    return joinPath(this.snapshotsDirectory(), `${snapshotId}.json`);
  }

  private async readText(path: string): Promise<string | null> {
    try {
      return await invoke<string | null>('read_optional_file', { path });
    } catch (error) {
      throw transportError(error, 'read the sync file');
    }
  }

  private async writeText(path: string, content: string): Promise<void> {
    try {
      await invoke('write_document_file', { path, document: content });
    } catch (error) {
      throw transportError(error, 'write the sync file');
    }
  }

  async resolveLocation(): Promise<ResolvedSyncLocation> {
    return {
      location: this.location,
      transportId: this.exchangeRoot,
      displayPath: this.exchangeRoot,
    };
  }

  async connect(): Promise<ResolvedSyncLocation> {
    try {
      await invoke('ensure_directory', { path: this.exchangeRoot });
      await invoke('ensure_directory', { path: this.snapshotsDirectory() });
    } catch (error) {
      throw transportError(error, 'prepare the local sync folder');
    }
    return this.resolveLocation();
  }

  async readManifest(): Promise<VersionedRemoteFile | null> {
    const content = await this.readText(this.manifestPath());
    if (content === null) return null;
    const version = versionForContent(content);
    return { entry: fileEntry(this.manifestPath(), version), content, version };
  }

  async writeManifest(content: string, expectedVersion?: string | null): Promise<VersionedRemoteFile> {
    const path = this.manifestPath();
    if (expectedVersion !== undefined) {
      const current = await this.readText(path);
      const currentVersion = current === null ? null : versionForContent(current);
      if (currentVersion !== expectedVersion) {
        throw new SyncTransportError('conflict', 'The sync manifest changed before it could be updated.', true);
      }
    }
    await this.writeText(path, content);
    const version = versionForContent(content);
    return { entry: fileEntry(path, version), content, version };
  }

  async listSnapshots(): Promise<SyncRemoteEntry[]> {
    let files: string[];
    try {
      files = await invoke<string[]>('list_directory_files', { path: this.snapshotsDirectory() });
    } catch (error) {
      throw transportError(error, 'list sync snapshots');
    }
    return files
      .filter(file => file.toLowerCase().endsWith('.json'))
      .map(file => fileEntry(joinPath(this.snapshotsDirectory(), file)));
  }

  async readSnapshot(entry: SyncRemoteEntry): Promise<VersionedRemoteFile> {
    const content = await this.readText(entry.id);
    if (content === null) throw new SyncTransportError('not-found', `Snapshot ${entry.displayName} is no longer available.`, true);
    const version = versionForContent(content);
    return { entry: { ...entry, version }, content, version };
  }

  async createSnapshot(snapshotId: string, content: string): Promise<VersionedRemoteFile> {
    const path = this.snapshotPath(snapshotId);
    const existing = await this.readText(path);
    if (existing !== null) {
      if (!equivalentJson(existing, content)) {
        throw new SyncTransportError('conflict', `Snapshot ${snapshotId} already exists with different content.`, false);
      }
      const version = versionForContent(existing);
      return { entry: fileEntry(path, version), content: existing, version };
    }
    await this.writeText(path, content);
    const version = versionForContent(content);
    return { entry: fileEntry(path, version), content, version };
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const path = this.snapshotPath(snapshotId);
    try {
      await invoke('remove_file', { path });
    } catch (error) {
      throw transportError(error, 'remove the sync snapshot');
    }
  }
}
