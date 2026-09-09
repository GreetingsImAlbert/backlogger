import type { SyncLocation } from '../sync.ts';

export type SyncTransportKind = 'local-folder' | 'onedrive' | 'supabase';

export type SyncTransportErrorCode =
  | 'location-unavailable'
  | 'not-found'
  | 'permission'
  | 'auth-required'
  | 'rate-limited'
  | 'server'
  | 'conflict'
  | 'offline'
  | 'invalid'
  | 'unsupported';

export class SyncTransportError extends Error {
  readonly code: SyncTransportErrorCode;
  readonly retriable: boolean;
  readonly cause?: unknown;

  constructor(code: SyncTransportErrorCode, message: string, retriable = false, cause?: unknown) {
    super(message);
    this.name = 'SyncTransportError';
    this.code = code;
    this.retriable = retriable;
    this.cause = cause;
  }
}

/** Metadata returned by a transport without exposing provider-specific URLs. */
export interface SyncRemoteEntry {
  /** Opaque identifier understood only by the selected transport. */
  id: string;
  /** Filename or user-facing label for diagnostics. */
  displayName: string;
  kind: 'file' | 'folder';
  /** Provider version/ETag, or a best-effort content version for local files. */
  version: string | null;
}

export interface VersionedRemoteFile {
  entry: SyncRemoteEntry;
  content: string;
  version: string;
}

export interface SyncTransportCapabilities {
  /** Whether manifest writes can be guarded by a provider-native version token. */
  conditionalManifestWrite: 'best-effort' | 'strong' | 'unsupported';
  /** Snapshot creation must never replace a different payload under the same ID. */
  immutableSnapshotCreate: 'best-effort' | 'strong';
  /** Whether the coordinator may request snapshot deletion for retention. */
  snapshotDeletion: 'best-effort' | 'strong' | 'unsupported';
}

export interface ResolvedSyncLocation {
  location: SyncLocation;
  /** Opaque transport binding used for diagnostics or future provider IDs. */
  transportId: string;
  displayPath: string;
}

/**
 * Exchange operations shared by every sync provider.
 * Protocol parsing and ancestry decisions stay in SyncCoordinator above this boundary.
 */
export interface SyncTransport {
  readonly kind: SyncTransportKind;
  readonly location: SyncLocation;
  readonly capabilities: SyncTransportCapabilities;

  resolveLocation(): Promise<ResolvedSyncLocation>;
  connect(): Promise<ResolvedSyncLocation>;
  readManifest(): Promise<VersionedRemoteFile | null>;
  writeManifest(content: string, expectedVersion?: string | null): Promise<VersionedRemoteFile>;
  listSnapshots(): Promise<SyncRemoteEntry[]>;
  readSnapshot(entry: SyncRemoteEntry): Promise<VersionedRemoteFile>;
  createSnapshot(snapshotId: string, content: string): Promise<VersionedRemoteFile>;
  deleteSnapshot(snapshotId: string): Promise<void>;
  /** Provider-specific atomic first-notebook initialization, when supported. */
  initializeNotebook?(notebookId: string, snapshotId: string, snapshotContent: string, manifestContent: string): Promise<VersionedRemoteFile>;
}
