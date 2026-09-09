import { getConfiguredSupabaseProject, getSupabaseClient } from '../supabase/client.ts';
import type { SupabaseLocation } from '../sync.ts';
import { SyncTransportError, type ResolvedSyncLocation, type SyncRemoteEntry, type SyncTransport, type SyncTransportCapabilities, type VersionedRemoteFile } from './transport.ts';

type SupabaseResponse<T> = {
  data: T | null;
  error: unknown | null;
};

interface SupabaseQuery {
  eq(column: string, value: string): SupabaseQuery;
  order(column: string, options?: { ascending?: boolean }): SupabaseQuery;
  range(from: number, to: number): Promise<SupabaseResponse<unknown[]>>;
}

interface SupabaseTransportClient {
  auth: {
    getUser(): Promise<SupabaseResponse<{ user: { id?: string } | null }>>;
  };
  from(table: 'sync_notebooks' | 'sync_snapshots'): {
    select(columns: string): SupabaseQuery;
  };
  rpc(functionName: string, args: Record<string, unknown>): Promise<SupabaseResponse<unknown>>;
}

export interface SupabaseSyncTransportOptions {
  /** A narrow fake is used by deterministic tests; production uses the singleton client. */
  client?: SupabaseTransportClient;
  /** Test-only project reference override when no Vite configuration is present. */
  projectRef?: string;
  /** Small pages keep snapshot history independent of the provider's default row limit. */
  pageSize?: number;
}

interface ErrorRecord {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

interface NotebookRow {
  notebook_id: string;
  manifest: unknown;
  manifest_version: unknown;
}

interface SnapshotRow {
  snapshot_id: string;
  payload: unknown;
}

interface ManifestRpcRow {
  applied?: unknown;
  manifest: unknown;
  manifest_version: unknown;
}

interface InitializationRpcRow {
  manifest: unknown;
  manifest_version: unknown;
}

interface SnapshotRpcRow {
  status: unknown;
  payload: unknown;
}

function errorRecord(error: unknown): ErrorRecord {
  return typeof error === 'object' && error !== null ? error as ErrorRecord : {};
}

function errorText(error: unknown): string {
  const record = errorRecord(error);
  return typeof record.message === 'string' ? record.message : '';
}

function errorCode(error: unknown): string {
  const code = errorRecord(error).code;
  return typeof code === 'string' ? code.toUpperCase() : '';
}

function errorStatus(error: unknown): number | null {
  const value = errorRecord(error).status;
  const status = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(status) ? status : null;
}

function mapSupabaseError(error: unknown, operation: string): SyncTransportError {
  if (error instanceof SyncTransportError) return error;
  const code = errorCode(error);
  const message = errorText(error);
  const status = errorStatus(error);
  const lowerMessage = message.toLowerCase();

  if (status === 401 || code === 'PGRST301' || /jwt|token|unauthenticated|not authenticated|sign in/i.test(lowerMessage)) {
    return new SyncTransportError('auth-required', 'Sign in to use cloud sync.', true, error);
  }
  if (status === 403 || code === '42501' || /permission|forbidden|row-level security|rls/i.test(lowerMessage)) {
    return new SyncTransportError('permission', 'Cloud sync permission was denied.', false, error);
  }
  if (status === 429 || /rate.?limit|too many requests/i.test(lowerMessage)) {
    return new SyncTransportError('rate-limited', 'Cloud sync is temporarily rate limited. Try again shortly.', true, error);
  }
  if (code === 'P0001' || code === '23505' || /immutable|already exists|manifest changed|still a head|not marked pruned/i.test(lowerMessage)) {
    return new SyncTransportError('conflict', 'Cloud sync rejected the requested change because the remote state changed.', false, error);
  }
  if (status === 404 || code === 'PGRST116' || /not found|no rows/i.test(lowerMessage)) {
    return new SyncTransportError('not-found', 'The requested cloud sync record is no longer available.', true, error);
  }
  if (/network|fetch|offline|timeout|timed out|unreachable|connection/i.test(lowerMessage)) {
    return new SyncTransportError('offline', 'Cloud sync is unavailable. Check your connection and try again.', true, error);
  }
  if (code.startsWith('22') || /invalid|malformed|violat/i.test(lowerMessage)) {
    return new SyncTransportError('invalid', 'Supabase returned invalid cloud sync data.', false, error);
  }
  if (status !== null && status >= 500) {
    return new SyncTransportError('server', 'Supabase is temporarily unavailable. Try again later.', true, error);
  }
  return new SyncTransportError('server', `Could not ${operation}.`, true, error);
}

function invalidData(message: string): SyncTransportError {
  return new SyncTransportError('invalid', message, false);
}

function nonblank(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalidData(`Supabase returned an invalid ${label}.`);
  return value;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidData(`Supabase returned an invalid ${label}.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    throw invalidData(`The ${label} is not valid JSON.`);
  }
  return objectValue(value, label);
}

function stringifyJsonObject(value: unknown, label: string): string {
  const object = objectValue(value, label);
  try {
    const content = JSON.stringify(object);
    if (!content) throw new Error('empty JSON');
    return content;
  } catch {
    throw invalidData(`Supabase returned an invalid ${label}.`);
  }
}

function rowsValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw invalidData(`Supabase returned an invalid ${label} response.`);
  return value;
}

function oneRpcRow(value: unknown, label: string): Record<string, unknown> {
  const rows = rowsValue(value, label);
  if (rows.length !== 1) throw invalidData(`Supabase returned an invalid ${label} response.`);
  return objectValue(rows[0], label);
}

function manifestVersion(value: unknown): string {
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) return String(value);
  throw invalidData('Supabase returned an invalid manifest version.');
}

function expectedManifestVersion(value: string): number {
  if (!/^[1-9]\d*$/.test(value)) throw invalidData('The expected manifest version is invalid.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalidData('The expected manifest version is invalid.');
  return number;
}

function notebookEntry(notebookId: string, content: string, version: string): VersionedRemoteFile {
  return {
    entry: { id: notebookId, displayName: 'notebook.json', kind: 'file', version },
    content,
    version,
  };
}

function snapshotEntry(snapshotId: string, content: string): VersionedRemoteFile {
  // Supabase has no mutable snapshot ETag. The immutable ID is the only
  // provider version needed by the coordinator for a snapshot resource.
  return {
    entry: { id: snapshotId, displayName: `${snapshotId}.json`, kind: 'file', version: snapshotId },
    content,
    version: snapshotId,
  };
}

function asTransportClient(client: unknown): SupabaseTransportClient {
  return client as SupabaseTransportClient;
}

export class SupabaseSyncTransport implements SyncTransport {
  readonly kind = 'supabase' as const;
  readonly location: SupabaseLocation;
  readonly capabilities: SyncTransportCapabilities = {
    conditionalManifestWrite: 'strong',
    immutableSnapshotCreate: 'strong',
    snapshotDeletion: 'strong',
  };

  private readonly client: SupabaseTransportClient;
  private readonly projectRef: string;
  private readonly pageSize: number;
  private activeNotebookId: string | null = null;

  constructor(location: SupabaseLocation, options: SupabaseSyncTransportOptions = {}) {
    const accountId = location.accountId.trim();
    const locationProjectRef = location.projectRef.trim();
    if (!accountId || !locationProjectRef) throw invalidData('A Supabase account and project are required.');

    const configured = options.client ? null : getConfiguredSupabaseProject();
    const projectRef = (options.projectRef ?? configured?.projectRef ?? '').trim();
    if (!projectRef) throw new SyncTransportError('invalid', 'Supabase sync is not configured.', false);
    if (projectRef !== locationProjectRef) {
      throw new SyncTransportError('conflict', 'The selected Supabase project does not match this app.', false);
    }

    const client = options.client ?? getSupabaseClient();
    if (!client) throw new SyncTransportError('invalid', 'Supabase sync is not configured.', false);

    this.location = { kind: 'supabase', accountId, projectRef: locationProjectRef };
    this.projectRef = projectRef;
    this.client = asTransportClient(client);
    this.pageSize = Number.isInteger(options.pageSize) && (options.pageSize ?? 0) > 0
      ? Math.min(options.pageSize as number, 1000)
      : 100;
  }

  private async runQuery(query: () => Promise<SupabaseResponse<unknown[]>>, operation: string): Promise<unknown[]> {
    try {
      const response = await query();
      if (response.error) throw mapSupabaseError(response.error, operation);
      return rowsValue(response.data, operation);
    } catch (error) {
      throw mapSupabaseError(error, operation);
    }
  }

  private async runRpc(functionName: string, args: Record<string, unknown>, operation: string): Promise<unknown> {
    try {
      const response = await this.client.rpc(functionName, args);
      if (response.error) throw mapSupabaseError(response.error, operation);
      return response.data;
    } catch (error) {
      throw mapSupabaseError(error, operation);
    }
  }

  private async assertBound(): Promise<void> {
    let response: SupabaseResponse<{ user: { id?: string } | null }>;
    try {
      response = await this.client.auth.getUser();
    } catch (error) {
      throw mapSupabaseError(error, 'validate the Supabase session');
    }
    if (response.error) throw mapSupabaseError(response.error, 'validate the Supabase session');
    const userId = response.data?.user?.id;
    if (!userId) throw new SyncTransportError('auth-required', 'Sign in to use cloud sync.', true);
    if (userId !== this.location.accountId) {
      throw new SyncTransportError('conflict', 'The signed-in Supabase account changed. Confirm the account before syncing.', false);
    }
  }

  async resolveLocation(): Promise<ResolvedSyncLocation> {
    await this.assertBound();
    return {
      location: this.location,
      transportId: `supabase:${this.projectRef}:${this.location.accountId}`,
      displayPath: `${this.projectRef}/${this.location.accountId}`,
    };
  }

  async connect(): Promise<ResolvedSyncLocation> {
    return this.resolveLocation();
  }

  private async requireNotebookId(): Promise<string> {
    await this.resolveLocation();
    if (this.activeNotebookId) return this.activeNotebookId;
    const manifest = await this.readManifest();
    if (!manifest || !this.activeNotebookId) {
      throw new SyncTransportError('not-found', 'This Supabase account has no initialized Backlogger notebook.', false);
    }
    return this.activeNotebookId;
  }

  async readManifest(): Promise<VersionedRemoteFile | null> {
    await this.resolveLocation();
    const rows = await this.runQuery(
      () => this.client
        .from('sync_notebooks')
        .select('notebook_id, manifest, manifest_version')
        .eq('owner_id', this.location.accountId)
        .range(0, 1),
      'read the cloud manifest',
    );
    if (rows.length === 0) {
      this.activeNotebookId = null;
      return null;
    }
    if (rows.length > 1) throw invalidData('Supabase returned multiple notebooks for one account.');
    const row = objectValue(rows[0], 'cloud manifest') as Partial<NotebookRow>;
    const notebookId = nonblank(row.notebook_id, 'notebook id');
    const content = stringifyJsonObject(row.manifest, 'cloud manifest');
    const version = manifestVersion(row.manifest_version);
    this.activeNotebookId = notebookId;
    return notebookEntry(notebookId, content, version);
  }

  async initializeNotebook(notebookId: string, snapshotId: string, snapshotContent: string, manifestContent: string): Promise<VersionedRemoteFile> {
    await this.resolveLocation();
    const safeNotebookId = notebookId.trim();
    const safeSnapshotId = snapshotId.trim();
    if (!safeNotebookId || !safeSnapshotId) throw invalidData('The initial notebook and snapshot ids are required.');
    const snapshot = parseJsonObject(snapshotContent, 'initial checkpoint');
    const manifest = parseJsonObject(manifestContent, 'initial manifest');
    if (snapshot.notebookId !== safeNotebookId || snapshot.snapshotId !== safeSnapshotId || snapshot.type !== 'checkpoint') {
      throw invalidData('The initial snapshot does not match the requested notebook.');
    }
    if (!Array.isArray(snapshot.parentSnapshotIds) || snapshot.parentSnapshotIds.length !== 0) {
      throw invalidData('The initial checkpoint must not have parents.');
    }
    if (manifest.notebookId !== safeNotebookId || !Array.isArray(manifest.headSnapshotIds)
      || manifest.headSnapshotIds.length !== 1 || manifest.headSnapshotIds[0] !== safeSnapshotId
      || !Array.isArray(manifest.prunedSnapshotIds) || manifest.prunedSnapshotIds.length !== 0) {
      throw invalidData('The initial manifest does not match the checkpoint.');
    }

    const data = await this.runRpc('initialize_sync_notebook', {
      p_notebook_id: safeNotebookId,
      p_snapshot_id: safeSnapshotId,
      p_snapshot: snapshot,
      p_manifest: manifest,
    }, 'initialize the cloud notebook');
    const row = oneRpcRow(data, 'cloud notebook initialization') as Partial<InitializationRpcRow>;
    const content = stringifyJsonObject(row.manifest, 'initialized cloud manifest');
    const version = manifestVersion(row.manifest_version);
    this.activeNotebookId = safeNotebookId;
    return notebookEntry(safeNotebookId, content, version);
  }

  async writeManifest(content: string, expectedVersion?: string | null): Promise<VersionedRemoteFile> {
    await this.resolveLocation();
    if (expectedVersion === undefined || expectedVersion === null) {
      throw invalidData('Supabase manifest updates require an expected version.');
    }
    const manifest = parseJsonObject(content, 'manifest');
    const notebookId = nonblank(manifest.notebookId, 'manifest notebook id');
    const activeNotebookId = await this.requireNotebookId();
    if (notebookId !== activeNotebookId) {
      throw new SyncTransportError('conflict', 'The cloud manifest belongs to a different notebook.', false);
    }
    const data = await this.runRpc('compare_and_swap_sync_manifest', {
      p_notebook_id: activeNotebookId,
      p_expected_manifest_version: expectedManifestVersion(expectedVersion),
      p_manifest: manifest,
    }, 'update the cloud manifest');
    const row = oneRpcRow(data, 'cloud manifest update') as Partial<ManifestRpcRow>;
    if (row.applied !== true) {
      throw new SyncTransportError('conflict', 'The cloud manifest changed before it could be updated.', true);
    }
    const returnedContent = stringifyJsonObject(row.manifest, 'updated cloud manifest');
    const version = manifestVersion(row.manifest_version);
    return notebookEntry(activeNotebookId, returnedContent, version);
  }

  async listSnapshots(): Promise<SyncRemoteEntry[]> {
    const notebookId = await this.requireNotebookId();
    const entries: SyncRemoteEntry[] = [];
    const seen = new Set<string>();
    for (let offset = 0; ; offset += this.pageSize) {
      const rows = await this.runQuery(
        () => this.client
          .from('sync_snapshots')
          .select('snapshot_id')
          .eq('notebook_id', notebookId)
          .order('snapshot_id', { ascending: true })
          .range(offset, offset + this.pageSize - 1),
        'list cloud snapshots',
      );
      for (const value of rows) {
        const row = objectValue(value, 'cloud snapshot index') as Partial<SnapshotRow>;
        const snapshotId = nonblank(row.snapshot_id, 'snapshot id');
        if (seen.has(snapshotId)) throw invalidData('Supabase returned duplicate snapshot ids.');
        seen.add(snapshotId);
        entries.push({ id: snapshotId, displayName: `${snapshotId}.json`, kind: 'file', version: null });
      }
      if (rows.length < this.pageSize) break;
    }
    return entries;
  }

  async readSnapshot(entry: SyncRemoteEntry): Promise<VersionedRemoteFile> {
    const notebookId = await this.requireNotebookId();
    const snapshotId = nonblank(entry.id, 'snapshot id');
    const rows = await this.runQuery(
      () => this.client
        .from('sync_snapshots')
        .select('snapshot_id, payload')
        .eq('notebook_id', notebookId)
        .eq('snapshot_id', snapshotId)
        .range(0, 1),
      'read the cloud snapshot',
    );
    if (rows.length === 0) throw new SyncTransportError('not-found', `Snapshot ${entry.displayName} is no longer available.`, true);
    if (rows.length > 1) throw invalidData('Supabase returned duplicate snapshot records.');
    const row = objectValue(rows[0], 'cloud snapshot') as Partial<SnapshotRow>;
    const returnedId = nonblank(row.snapshot_id, 'snapshot id');
    if (returnedId !== snapshotId) throw invalidData('Supabase returned a mismatched snapshot.');
    const content = stringifyJsonObject(row.payload, 'cloud snapshot payload');
    return snapshotEntry(returnedId, content);
  }

  async createSnapshot(snapshotId: string, content: string): Promise<VersionedRemoteFile> {
    const notebookId = await this.requireNotebookId();
    const safeSnapshotId = snapshotId.trim();
    if (!safeSnapshotId) throw invalidData('The snapshot id is required.');
    const payload = parseJsonObject(content, 'snapshot');
    if (payload.notebookId !== notebookId || payload.snapshotId !== safeSnapshotId) {
      throw invalidData('The snapshot does not match the active notebook.');
    }
    const data = await this.runRpc('create_sync_snapshot', {
      p_notebook_id: notebookId,
      p_snapshot_id: safeSnapshotId,
      p_payload: payload,
    }, 'create the cloud snapshot');
    const row = oneRpcRow(data, 'cloud snapshot creation') as Partial<SnapshotRpcRow>;
    if (row.status !== 'created' && row.status !== 'already-identical') {
      throw invalidData('Supabase returned an unknown snapshot creation status.');
    }
    const returnedPayload = stringifyJsonObject(row.payload, 'cloud snapshot payload');
    return snapshotEntry(safeSnapshotId, returnedPayload);
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    const notebookId = await this.requireNotebookId();
    const safeSnapshotId = nonblank(snapshotId, 'snapshot id');
    const data = await this.runRpc('delete_pruned_sync_snapshot', {
      p_notebook_id: notebookId,
      p_snapshot_id: safeSnapshotId,
    }, 'delete the cloud snapshot');
    if (data !== true) throw invalidData('Supabase returned an invalid snapshot deletion response.');
  }
}
