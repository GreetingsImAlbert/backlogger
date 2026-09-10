import { invoke } from '@tauri-apps/api/core';
import type { Category, Notebook, Task } from './model.ts';
import { parseStoredDocument, SCHEMA_VERSION, storageKind, type StoredDocument, type Theme, type ViewMode } from './storage.ts';

export const LEGACY_SYNC_SCHEMA_VERSION = 1 as const;
export const PREVIOUS_SYNC_SCHEMA_VERSION = 2 as const;
export const SYNC_SCHEMA_VERSION = 3 as const;
export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_SNAPSHOT_RETENTION_LIMIT = 30 as const;
export const SYNC_CHECKPOINT_VERSION = 1 as const;

export type SyncConnectionStatus = 'disconnected' | 'connected' | 'paused';

export interface LocalFolderLocation {
  kind: 'local-folder';
  /** Parent directory selected by the Windows folder picker. */
  parentPath: string;
}

export interface OneDriveLocation {
  kind: 'onedrive';
  accountId: string;
  driveId: string;
  rootItemId: string;
  /** `/backlogger-sync` or the explicit debug path used for isolated tests. */
  displayPath: string;
}

export interface SupabaseLocation {
  kind: 'supabase';
  /** Supabase Auth user id; never use the user's email as the identity key. */
  accountId: string;
  /** Non-secret project reference used to prevent cross-project reconnects. */
  projectRef: string;
}

export type SyncLocation = LocalFolderLocation | OneDriveLocation | SupabaseLocation;

export interface SyncSnapshot {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  type: 'snapshot' | 'checkpoint';
  checkpointVersion?: typeof SYNC_CHECKPOINT_VERSION;
  snapshotId: string;
  notebookId: string;
  deviceId: string;
  parentSnapshotIds: string[];
  createdAt: string;
  revision: number;
  categories: Category[];
}

export interface SyncManifest {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  type: 'manifest';
  notebookId: string;
  createdAt: string;
  createdByDeviceId: string;
  headSnapshotIds: string[];
  prunedSnapshotIds: string[];
}

export type SyncConflictTarget = 'category' | 'task' | 'category-order' | 'task-order';

export interface SyncConflict {
  conflictId: string;
  target: SyncConflictTarget;
  categoryId: string | null;
  recordId: string;
  field: string;
  kind: 'field' | 'delete-edit' | 'ordering';
  localValue: unknown;
  remoteValue: unknown;
  baseValue: unknown;
  localSnapshotId: string;
  remoteSnapshotId: string;
  createdAt: string;
}

export interface SyncState {
  schemaVersion: typeof SYNC_SCHEMA_VERSION;
  deviceId: string;
  notebookId: string | null;
  location: SyncLocation | null;
  status: SyncConnectionStatus;
  pendingSnapshots: SyncSnapshot[];
  knownHeadSnapshotIds: string[];
  lastPublishedSnapshotId: string | null;
  lastPublishedRevision: number | null;
  lastPublishedContentFingerprint: string | null;
  lastPublishedAt: string | null;
  lastCheckedAt: string | null;
  lastSuccessfulCheckAt: string | null;
  currentSnapshotId: string | null;
  processedSnapshotIds: string[];
  mergeParentSnapshotIds: string[];
  conflicts: SyncConflict[];
  lastError: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Sync data has an invalid ${field}.`);
  return value;
}

function optionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, field);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`Sync data has invalid ${field}.`);
  }
  return [...new Set(value)];
}

function parseSyncLocation(value: unknown, allowSupabase: boolean, field = 'sync location'): SyncLocation {
  if (!isRecord(value) || (value.kind !== 'local-folder' && value.kind !== 'onedrive' && value.kind !== 'supabase')) {
    throw new Error(`Sync data has an invalid ${field}.`);
  }
  if (value.kind === 'local-folder') {
    return { kind: 'local-folder', parentPath: requiredString(value.parentPath, `${field} parent path`) };
  }
  if (value.kind === 'supabase') {
    if (!allowSupabase) throw new Error(`Sync data has a Supabase location before the schema-3 migration.`);
    return {
      kind: 'supabase',
      accountId: requiredString(value.accountId, `${field} account id`),
      projectRef: requiredString(value.projectRef, `${field} project reference`),
    };
  }
  return {
    kind: 'onedrive',
    accountId: requiredString(value.accountId, `${field} account id`),
    driveId: requiredString(value.driveId, `${field} drive id`),
    rootItemId: requiredString(value.rootItemId, `${field} root item id`),
    displayPath: requiredString(value.displayPath, `${field} display path`),
  };
}

export function localFolderLocation(location: SyncLocation | null): LocalFolderLocation | null {
  return location?.kind === 'local-folder' ? location : null;
}

function cloneTasks(tasks: Task[]): Task[] {
  return tasks.map(task => ({ ...task, scheduledDates: [...task.scheduledDates] }));
}

function cloneCategories(categories: Category[]): Category[] {
  return categories.map(category => ({
    ...category,
    tasks: cloneTasks(category.tasks),
  }));
}

export function parseSyncSnapshot(value: unknown, label = 'snapshot'): SyncSnapshot {
  if (!isRecord(value)) throw new Error(`${label} is invalid.`);
  if (value.protocolVersion !== SYNC_PROTOCOL_VERSION || (value.type !== 'snapshot' && value.type !== 'checkpoint')) {
    throw new Error(`${label} uses an unsupported protocol.`);
  }
  if (value.type === 'checkpoint' && value.checkpointVersion !== SYNC_CHECKPOINT_VERSION) {
    throw new Error(`${label} uses an unsupported checkpoint version.`);
  }
  const revision = value.revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new Error(`${label} has an invalid revision.`);
  }
  const categoriesValue = value.categories;
  if (!Array.isArray(categoriesValue)) throw new Error(`${label} has invalid categories.`);
  const validated = parseStoredDocument({
    schemaVersion: SCHEMA_VERSION,
    revision,
    categories: categoriesValue,
    preferences: { viewMode: 'all', theme: 'dark' },
  });
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    type: value.type,
    ...(value.type === 'checkpoint' ? { checkpointVersion: SYNC_CHECKPOINT_VERSION } : {}),
    snapshotId: requiredString(value.snapshotId, `${label} id`),
    notebookId: requiredString(value.notebookId, `${label} notebook id`),
    deviceId: requiredString(value.deviceId, `${label} device id`),
    parentSnapshotIds: stringArray(value.parentSnapshotIds, `${label} parents`),
    createdAt: requiredString(value.createdAt, `${label} creation time`),
    revision,
    categories: validated.categories,
  };
}

function parseConflict(value: unknown, index: number): SyncConflict {
  if (!isRecord(value)) throw new Error(`Sync conflict ${index + 1} is invalid.`);
  const target = value.target;
  if (target !== 'category' && target !== 'task' && target !== 'category-order' && target !== 'task-order') {
    throw new Error(`Sync conflict ${index + 1} has an invalid target.`);
  }
  const kind = value.kind;
  if (kind !== 'field' && kind !== 'delete-edit' && kind !== 'ordering') {
    throw new Error(`Sync conflict ${index + 1} has an invalid kind.`);
  }
  return {
    conflictId: requiredString(value.conflictId, `sync conflict ${index + 1} id`),
    target,
    categoryId: optionalString(value.categoryId, `sync conflict ${index + 1} category id`),
    recordId: requiredString(value.recordId, `sync conflict ${index + 1} record id`),
    field: requiredString(value.field, `sync conflict ${index + 1} field`),
    kind,
    localValue: value.localValue ?? null,
    remoteValue: value.remoteValue ?? null,
    baseValue: value.baseValue ?? null,
    localSnapshotId: requiredString(value.localSnapshotId, `sync conflict ${index + 1} local snapshot id`),
    remoteSnapshotId: requiredString(value.remoteSnapshotId, `sync conflict ${index + 1} remote snapshot id`),
    createdAt: requiredString(value.createdAt, `sync conflict ${index + 1} creation time`),
  };
}

export function makeSyncState(deviceId: string = crypto.randomUUID()): SyncState {
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    deviceId,
    notebookId: null,
    location: null,
    status: 'disconnected',
    pendingSnapshots: [],
    knownHeadSnapshotIds: [],
    lastPublishedSnapshotId: null,
    lastPublishedRevision: null,
    lastPublishedContentFingerprint: null,
    lastPublishedAt: null,
    lastCheckedAt: null,
    lastSuccessfulCheckAt: null,
    currentSnapshotId: null,
    processedSnapshotIds: [],
    mergeParentSnapshotIds: [],
    conflicts: [],
    lastError: null,
  };
}

export function parseSyncState(value: unknown): SyncState {
  if (!isRecord(value)) throw new Error('Sync data is not an object.');
  if (value.schemaVersion !== SYNC_SCHEMA_VERSION
    && value.schemaVersion !== PREVIOUS_SYNC_SCHEMA_VERSION
    && value.schemaVersion !== LEGACY_SYNC_SCHEMA_VERSION) {
    throw new Error('This sync data uses an unsupported version.');
  }
  const isCurrentSchema = value.schemaVersion === SYNC_SCHEMA_VERSION;
  const status = value.status;
  if (status !== 'disconnected' && status !== 'connected' && status !== 'paused') {
    throw new Error('Sync data has an invalid connection status.');
  }
  const pendingValue = value.pendingSnapshots;
  if (!Array.isArray(pendingValue)) throw new Error('Sync data has invalid pending snapshots.');
  const pendingSnapshots = pendingValue.map((snapshot, index) => parseSyncSnapshot(snapshot, `Pending snapshot ${index + 1}`));
  const snapshotIds = new Set<string>();
  pendingSnapshots.forEach(snapshot => {
    if (snapshotIds.has(snapshot.snapshotId)) throw new Error('Sync data has duplicate pending snapshot ids.');
    snapshotIds.add(snapshot.snapshotId);
  });
  const conflictsValue = value.conflicts ?? [];
  if (!Array.isArray(conflictsValue)) throw new Error('Sync data has invalid conflicts.');
  const legacyFolderPath = value.folderPath === undefined ? null : optionalString(value.folderPath, 'folder path');
  const parsedLocation = value.location === undefined || value.location === null
    ? null
    : parseSyncLocation(value.location, isCurrentSchema);
  if (isCurrentSchema && (legacyFolderPath || (parsedLocation && parsedLocation.kind !== 'supabase'))) {
    throw new Error('Schema-3 sync data cannot contain a retired folder location.');
  }
  if (parsedLocation && legacyFolderPath && parsedLocation.kind === 'local-folder' && parsedLocation.parentPath !== legacyFolderPath) {
    throw new Error('Sync data has conflicting location and folder path values.');
  }
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    deviceId: requiredString(value.deviceId, 'device id'),
    notebookId: optionalString(value.notebookId, 'notebook id'),
    location: parsedLocation ?? (legacyFolderPath ? { kind: 'local-folder', parentPath: legacyFolderPath } : null),
    status,
    pendingSnapshots,
    knownHeadSnapshotIds: stringArray(value.knownHeadSnapshotIds ?? [], 'known heads'),
    lastPublishedSnapshotId: optionalString(value.lastPublishedSnapshotId, 'last published snapshot id'),
    lastPublishedRevision: value.lastPublishedRevision === null || value.lastPublishedRevision === undefined
      ? null
      : (typeof value.lastPublishedRevision === 'number' && Number.isInteger(value.lastPublishedRevision) && value.lastPublishedRevision >= 0
        ? value.lastPublishedRevision
        : (() => { throw new Error('Sync data has an invalid last published revision.'); })()),
    lastPublishedContentFingerprint: optionalString(value.lastPublishedContentFingerprint, 'last published content fingerprint'),
    lastPublishedAt: optionalString(value.lastPublishedAt, 'last published time'),
    lastCheckedAt: optionalString(value.lastCheckedAt, 'last sync check time'),
    lastSuccessfulCheckAt: optionalString(value.lastSuccessfulCheckAt, 'last successful sync check time'),
    currentSnapshotId: optionalString(value.currentSnapshotId ?? value.lastPublishedSnapshotId, 'current snapshot id'),
    processedSnapshotIds: stringArray(value.processedSnapshotIds ?? [], 'processed snapshots'),
    mergeParentSnapshotIds: stringArray(value.mergeParentSnapshotIds ?? [], 'merge parents'),
    conflicts: conflictsValue.map(parseConflict),
    lastError: optionalString(value.lastError, 'last error'),
  };
}

export function makeSyncSnapshot(document: StoredDocument, state: SyncState, parentSnapshotIds: string[]): SyncSnapshot {
  if (!state.notebookId) throw new Error('A notebook identity is required before creating a snapshot.');
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    type: 'snapshot',
    snapshotId: crypto.randomUUID(),
    notebookId: state.notebookId,
    deviceId: state.deviceId,
    parentSnapshotIds: [...new Set(parentSnapshotIds)],
    createdAt: new Date().toISOString(),
    revision: document.revision,
    categories: cloneCategories(document.categories),
  };
}

export function makeCheckpointSnapshot(document: StoredDocument, state: SyncState): SyncSnapshot {
  return {
    ...makeSyncSnapshot(document, state, []),
    type: 'checkpoint',
    checkpointVersion: SYNC_CHECKPOINT_VERSION,
  };
}

export function parseSyncManifest(value: unknown): SyncManifest {
  if (!isRecord(value)) throw new Error('The sync manifest is not an object.');
  if (value.protocolVersion !== SYNC_PROTOCOL_VERSION || value.type !== 'manifest') {
    throw new Error('The sync manifest uses an unsupported manifest protocol version.');
  }
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    type: 'manifest',
    notebookId: requiredString(value.notebookId, 'manifest notebook id'),
    createdAt: requiredString(value.createdAt, 'manifest creation time'),
    createdByDeviceId: requiredString(value.createdByDeviceId, 'manifest device id'),
    headSnapshotIds: stringArray(value.headSnapshotIds, 'manifest heads'),
    prunedSnapshotIds: stringArray(value.prunedSnapshotIds ?? [], 'manifest pruned snapshots'),
  };
}

export function makeSyncManifest(notebookId: string, deviceId: string, headSnapshotIds: string[] = []): SyncManifest {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    type: 'manifest',
    notebookId,
    createdAt: new Date().toISOString(),
    createdByDeviceId: deviceId,
    headSnapshotIds: [...new Set(headSnapshotIds)],
    prunedSnapshotIds: [],
  };
}

export async function loadSyncState(): Promise<SyncState> {
  if (storageKind() === 'browser') return makeSyncState('browser-preview');
  const raw = await invoke<string | null>('load_sync_state');
  if (!raw) return makeSyncState();
  const parsed = JSON.parse(raw) as unknown;
  const { state, migrated } = migrateSyncState(parsed);
  if (migrated) {
    // Preserve the complete old state before writing a disconnected schema-3
    // state. The retired folder/account is never treated as a Supabase binding.
    await invoke('backup_sync_state');
    await invoke('save_sync_state', { state: JSON.stringify(state, null, 2) });
  }
  return state;
}

/**
 * Convert schema-1/2 state to a safe, disconnected schema-3 state. The old
 * location, pending publication, and remote history remain in the native
 * `.bak`; the live state must not publish that history to a newly logged-in
 * account.
 */
export function migrateSyncState(value: unknown): { state: SyncState; migrated: boolean } {
  const state = parseSyncState(value);
  const rawSchema = isRecord(value) && typeof value.schemaVersion === 'number' ? value.schemaVersion : null;
  if (rawSchema === SYNC_SCHEMA_VERSION) return { state, migrated: false };
  return {
    state: {
      ...state,
      schemaVersion: SYNC_SCHEMA_VERSION,
      location: null,
      status: 'disconnected',
      pendingSnapshots: [],
      knownHeadSnapshotIds: [],
      lastPublishedSnapshotId: null,
      lastPublishedRevision: null,
      lastPublishedContentFingerprint: null,
      lastPublishedAt: null,
      lastCheckedAt: null,
      lastSuccessfulCheckAt: null,
      currentSnapshotId: null,
      processedSnapshotIds: [],
      mergeParentSnapshotIds: [],
      conflicts: [],
      lastError: null,
    },
    migrated: true,
  };
}

export async function saveSyncState(state: SyncState): Promise<void> {
  if (storageKind() === 'browser') return;
  await invoke('save_sync_state', { state: JSON.stringify(state, null, 2) });
}

// Kept as compatibility exports for focused path tests; runtime I/O is implemented by LocalFolderSyncTransport.
export { syncManifestPath, syncRootPath, syncSnapshotPath, syncSnapshotsPath } from './sync/local-folder-transport.ts';

export function snapshotFingerprint(snapshot: SyncSnapshot): string {
  return JSON.stringify(snapshot.categories);
}

export function notebookFingerprint(notebook: Pick<Notebook, 'categories'>): string {
  return JSON.stringify(notebook.categories);
}

/**
 * Deliberately simple union merge. Stable local ordering wins, remote-only
 * records append, and matching records combine their non-destructive values.
 */
export function mergeEverything(local: Notebook, remote: Notebook): Notebook {
  const remoteCategories = new Map(remote.categories.map(category => [category.id, category]));
  const categories = local.categories.map(localCategory => {
    const remoteCategory = remoteCategories.get(localCategory.id);
    if (!remoteCategory) return { ...localCategory, tasks: cloneTasks(localCategory.tasks) };
    remoteCategories.delete(localCategory.id);
    const remoteTasks = new Map(remoteCategory.tasks.map(task => [task.id, task]));
    const tasks = localCategory.tasks.map(localTask => {
      const remoteTask = remoteTasks.get(localTask.id);
      if (!remoteTask) return { ...localTask, scheduledDates: [...localTask.scheduledDates] };
      remoteTasks.delete(localTask.id);
      return {
        id: localTask.id,
        title: localTask.title || remoteTask.title,
        scheduledDates: [...new Set([...localTask.scheduledDates, ...remoteTask.scheduledDates])].sort(),
        deadlineDate: localTask.deadlineDate ?? remoteTask.deadlineDate,
      };
    });
    tasks.push(...[...remoteTasks.values()].map(task => ({ ...task, scheduledDates: [...task.scheduledDates] })));
    return { id: localCategory.id, name: localCategory.name || remoteCategory.name, tasks };
  });
  categories.push(...[...remoteCategories.values()].map(category => ({
    ...category,
    tasks: cloneTasks(category.tasks),
  })));
  return { categories };
}

export function notebookFromSnapshot(snapshot: SyncSnapshot): Notebook {
  return { categories: cloneCategories(snapshot.categories) };
}

export function storedDocumentFromSyncSnapshot(snapshot: SyncSnapshot, viewMode: ViewMode = 'all', theme: Theme = 'dark'): StoredDocument {
  return parseStoredDocument({
    schemaVersion: SCHEMA_VERSION,
    revision: snapshot.revision,
    categories: cloneCategories(snapshot.categories),
    preferences: { viewMode, theme },
  });
}

export function hasValidSnapshotParentRevisions(snapshot: SyncSnapshot, snapshots: Map<string, SyncSnapshot>): boolean {
  return snapshot.parentSnapshotIds.every(parentId => {
    const parent = snapshots.get(parentId);
    return !parent || snapshot.revision >= parent.revision;
  });
}

export function isSnapshotAncestor(ancestorId: string, descendantId: string, snapshots: Map<string, SyncSnapshot>): boolean {
  if (ancestorId === descendantId) return true;
  const visited = new Set<string>();
  const pending = [descendantId];
  while (pending.length) {
    const currentId = pending.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = snapshots.get(currentId);
    if (!current) continue;
    for (const parentId of current.parentSnapshotIds) {
      if (parentId === ancestorId) return true;
      pending.push(parentId);
    }
  }
  return false;
}

export function hasCompleteSnapshotAncestry(snapshot: SyncSnapshot, snapshots: Map<string, SyncSnapshot>): boolean {
  const visited = new Set<string>();
  const pending = [...snapshot.parentSnapshotIds];
  while (pending.length) {
    const currentId = pending.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const current = snapshots.get(currentId);
    if (!current) return false;
    pending.push(...current.parentSnapshotIds);
  }
  return true;
}

export function snapshotLeaves(snapshots: Map<string, SyncSnapshot>): SyncSnapshot[] {
  const parentIds = new Set<string>();
  snapshots.forEach(snapshot => snapshot.parentSnapshotIds.forEach(parentId => parentIds.add(parentId)));
  return [...snapshots.values()]
    .filter(snapshot => !parentIds.has(snapshot.snapshotId) && hasCompleteSnapshotAncestry(snapshot, snapshots))
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
}

export function reconcileManifestHeadIds(snapshots: Map<string, SyncSnapshot>, previousHeadIds: string[] = []): string[] {
  const observedSnapshotIds = new Set(snapshots.keys());
  const unobservedHeadIds = previousHeadIds.filter(snapshotId => !observedSnapshotIds.has(snapshotId));
  return [...new Set([...snapshotLeaves(snapshots).map(snapshot => snapshot.snapshotId), ...unobservedHeadIds])];
}

export function findCommonSnapshotAncestor(firstId: string, secondId: string, snapshots: Map<string, SyncSnapshot>): string | null {
  const firstAncestors = new Set<string>();
  const firstPending = [firstId];
  while (firstPending.length) {
    const currentId = firstPending.pop()!;
    if (firstAncestors.has(currentId)) continue;
    firstAncestors.add(currentId);
    const current = snapshots.get(currentId);
    if (current) firstPending.push(...current.parentSnapshotIds);
  }
  const secondPending = [secondId];
  const visited = new Set<string>();
  while (secondPending.length) {
    const currentId = secondPending.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    if (firstAncestors.has(currentId)) return currentId;
    const current = snapshots.get(currentId);
    if (current) secondPending.push(...current.parentSnapshotIds);
  }
  return null;
}

interface MergeContext {
  localSnapshotId: string;
  remoteSnapshotId: string;
  conflicts: SyncConflict[];
}

interface SequenceResult {
  ids: string[];
  conflict: boolean;
}

function valuesEqual(first: unknown, second: unknown): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function mergeSequence(base: string[], local: string[], remote: string[]): SequenceResult {
  const localChanged = !valuesEqual(base, local);
  const remoteChanged = !valuesEqual(base, remote);
  if (!localChanged) return { ids: [...remote], conflict: false };
  if (!remoteChanged || valuesEqual(local, remote)) return { ids: [...local], conflict: false };
  const commonLocal = local.filter(id => remote.includes(id));
  const commonRemote = remote.filter(id => local.includes(id));
  if (valuesEqual(commonLocal, commonRemote)) {
    return { ids: [...new Set([...local, ...remote])], conflict: false };
  }
  return { ids: [...local], conflict: true };
}

function addConflict(
  context: MergeContext,
  target: SyncConflictTarget,
  categoryId: string | null,
  recordId: string,
  field: string,
  kind: SyncConflict['kind'],
  localValue: unknown,
  remoteValue: unknown,
  baseValue: unknown,
) {
  context.conflicts.push({
    conflictId: crypto.randomUUID(),
    target,
    categoryId,
    recordId,
    field,
    kind,
    localValue: localValue ?? null,
    remoteValue: remoteValue ?? null,
    baseValue: baseValue ?? null,
    localSnapshotId: context.localSnapshotId,
    remoteSnapshotId: context.remoteSnapshotId,
    createdAt: new Date().toISOString(),
  });
}

function mergeField(
  context: MergeContext,
  target: 'category' | 'task',
  categoryId: string | null,
  recordId: string,
  field: string,
  baseValue: unknown,
  localValue: unknown,
  remoteValue: unknown,
): unknown {
  if (valuesEqual(localValue, remoteValue)) return localValue;
  if (valuesEqual(localValue, baseValue)) return remoteValue;
  if (valuesEqual(remoteValue, baseValue)) return localValue;
  addConflict(context, target, categoryId, recordId, field, 'field', localValue, remoteValue, baseValue);
  return localValue;
}

function mergeTask(base: Task | null, local: Task, remote: Task, categoryId: string, context: MergeContext): Task {
  return {
    id: local.id,
    title: String(mergeField(context, 'task', categoryId, local.id, 'title', base?.title ?? null, local.title, remote.title)),
    scheduledDates: [...(mergeField(context, 'task', categoryId, local.id, 'scheduledDates', base?.scheduledDates ?? null, local.scheduledDates, remote.scheduledDates) as string[])],
    deadlineDate: mergeField(context, 'task', categoryId, local.id, 'deadlineDate', base?.deadlineDate ?? null, local.deadlineDate, remote.deadlineDate) as string | null,
  };
}

function mergeTasks(base: Task[], local: Task[], remote: Task[], categoryId: string, context: MergeContext): Task[] {
  const baseById = new Map(base.map(task => [task.id, task]));
  const localById = new Map(local.map(task => [task.id, task]));
  const remoteById = new Map(remote.map(task => [task.id, task]));
  const taskIds = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);
  const merged = new Map<string, Task>();
  for (const taskId of taskIds) {
    const baseTask = baseById.get(taskId) ?? null;
    const localTask = localById.get(taskId) ?? null;
    const remoteTask = remoteById.get(taskId) ?? null;
    if (localTask && remoteTask) {
      merged.set(taskId, baseTask ? mergeTask(baseTask, localTask, remoteTask, categoryId, context) : mergeTask(null, localTask, remoteTask, categoryId, context));
    } else if (localTask || remoteTask) {
      const present = localTask ?? remoteTask!;
      if (!baseTask) {
        merged.set(taskId, { ...present, scheduledDates: [...present.scheduledDates] });
      } else if (valuesEqual(present, baseTask)) {
        // The other device deleted an unchanged record.
      } else {
        addConflict(context, 'task', categoryId, taskId, 'record', 'delete-edit', localTask, remoteTask, baseTask);
        if (localTask) merged.set(taskId, { ...localTask, scheduledDates: [...localTask.scheduledDates] });
      }
    }
  }
  const order = mergeSequence(base.map(task => task.id), local.map(task => task.id), remote.map(task => task.id));
  if (order.conflict) {
    addConflict(context, 'task-order', categoryId, categoryId, 'taskOrder', 'ordering', local.map(task => task.id), remote.map(task => task.id), base.map(task => task.id));
  }
  const orderedIds = [...order.ids, ...merged.keys()];
  return [...new Set(orderedIds)].map(taskId => merged.get(taskId)).filter((task): task is Task => Boolean(task));
}

function mergeCategory(base: Category | null, local: Category, remote: Category, context: MergeContext): Category {
  return {
    id: local.id,
    name: String(mergeField(context, 'category', null, local.id, 'name', base?.name ?? null, local.name, remote.name)),
    tasks: mergeTasks(base?.tasks ?? [], local.tasks, remote.tasks, local.id, context),
  };
}

export interface NotebookMergeResult {
  notebook: Notebook;
  conflicts: SyncConflict[];
}

export function mergeNotebooks(base: Notebook | null, local: Notebook, remote: Notebook, localSnapshotId: string, remoteSnapshotId: string): NotebookMergeResult {
  const context: MergeContext = { localSnapshotId, remoteSnapshotId, conflicts: [] };
  const baseById = new Map((base?.categories ?? []).map(category => [category.id, category]));
  const localById = new Map(local.categories.map(category => [category.id, category]));
  const remoteById = new Map(remote.categories.map(category => [category.id, category]));
  const categoryIds = new Set([...baseById.keys(), ...localById.keys(), ...remoteById.keys()]);
  const merged = new Map<string, Category>();
  for (const categoryId of categoryIds) {
    const baseCategory = baseById.get(categoryId) ?? null;
    const localCategory = localById.get(categoryId) ?? null;
    const remoteCategory = remoteById.get(categoryId) ?? null;
    if (localCategory && remoteCategory) {
      merged.set(categoryId, baseCategory ? mergeCategory(baseCategory, localCategory, remoteCategory, context) : mergeCategory(null, localCategory, remoteCategory, context));
    } else if (localCategory || remoteCategory) {
      const present = localCategory ?? remoteCategory!;
      if (!baseCategory) {
        merged.set(categoryId, { ...present, tasks: present.tasks.map(task => ({ ...task, scheduledDates: [...task.scheduledDates] })) });
      } else if (valuesEqual(present, baseCategory)) {
        // The other device deleted an unchanged category.
      } else {
        addConflict(context, 'category', null, categoryId, 'record', 'delete-edit', localCategory, remoteCategory, baseCategory);
        if (localCategory) merged.set(categoryId, { ...localCategory, tasks: localCategory.tasks.map(task => ({ ...task, scheduledDates: [...task.scheduledDates] })) });
      }
    }
  }
  const order = mergeSequence(
    base?.categories.map(category => category.id) ?? [],
    local.categories.map(category => category.id),
    remote.categories.map(category => category.id),
  );
  if (order.conflict) {
    addConflict(context, 'category-order', null, 'category-order', 'categoryOrder', 'ordering', local.categories.map(category => category.id), remote.categories.map(category => category.id), base?.categories.map(category => category.id) ?? []);
  }
  const orderedIds = [...order.ids, ...merged.keys()];
  return {
    notebook: { categories: [...new Set(orderedIds)].map(categoryId => merged.get(categoryId)).filter((category): category is Category => Boolean(category)) },
    conflicts: context.conflicts,
  };
}

export function applySyncConflict(notebook: Notebook, conflict: SyncConflict, value: unknown): Notebook {
  const next = { categories: cloneCategories(notebook.categories) };
  if (conflict.target === 'category-order') {
    const ids = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : [];
    const byId = new Map(next.categories.map(category => [category.id, category]));
    next.categories = [...new Set([...ids, ...next.categories.map(category => category.id)])].map(id => byId.get(id)).filter((category): category is Category => Boolean(category));
    return next;
  }
  const category = conflict.categoryId ? next.categories.find(item => item.id === conflict.categoryId) : undefined;
  if (conflict.target === 'task-order') {
    if (!category) return next;
    const ids = Array.isArray(value) ? value.filter(item => typeof item === 'string') as string[] : [];
    const byId = new Map(category.tasks.map(task => [task.id, task]));
    category.tasks = [...new Set([...ids, ...category.tasks.map(task => task.id)])].map(id => byId.get(id)).filter((task): task is Task => Boolean(task));
    return next;
  }
  if (conflict.target === 'category') {
    if (conflict.field === 'record') {
      next.categories = next.categories.filter(item => item.id !== conflict.recordId);
      if (isRecord(value) && typeof value.id === 'string') {
        next.categories.push({ id: value.id, name: String(value.name), tasks: Array.isArray(value.tasks) ? value.tasks as Task[] : [] });
      }
      return next;
    }
    if (category && conflict.field === 'name' && typeof value === 'string') category.name = value;
    return next;
  }
  if (!category) return next;
  if (conflict.field === 'record') {
    category.tasks = category.tasks.filter(task => task.id !== conflict.recordId);
    if (isRecord(value) && typeof value.id === 'string') {
      category.tasks.push({
        id: value.id,
        title: String(value.title),
        scheduledDates: Array.isArray(value.scheduledDates) ? value.scheduledDates as string[] : [],
        deadlineDate: typeof value.deadlineDate === 'string' ? value.deadlineDate : null,
      });
    }
    return next;
  }
  const task = category.tasks.find(item => item.id === conflict.recordId);
  if (!task) return next;
  if (conflict.field === 'title' && typeof value === 'string') task.title = value;
  if (conflict.field === 'scheduledDates' && Array.isArray(value)) task.scheduledDates = value.filter(item => typeof item === 'string') as string[];
  if (conflict.field === 'deadlineDate') task.deadlineDate = typeof value === 'string' ? value : null;
  return next;
}
