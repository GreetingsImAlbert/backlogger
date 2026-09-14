import type { Database, Json } from '../../supabase/database.types.ts';
import type { LocalRepository } from '../local-db/index.ts';
import type { Notebook, Task } from '../model.ts';
import { getConfiguredSupabaseProject, getSupabaseClient } from '../supabase/client.ts';
import { mergeEverything, hasCompleteSnapshotAncestry, type SyncManifest, type SyncSnapshot } from '../sync.ts';
import { reconcileRecord } from './merge.ts';
import { mapSupabaseRecordError } from './supabase-transport.ts';
import { RecordTransportError, type RecordSyncBinding } from './transport.ts';
import type { CategorySyncRecord, LocalSyncRecord, RecordSyncState, TaskSyncRecord } from './types.ts';

type V2NotebookRow = Database['public']['Tables']['sync_v2_notebooks']['Row'];
type InitializeArgs = Database['public']['Functions']['initialize_sync_v2_notebook']['Args'];
type InitializeRow = Database['public']['Functions']['initialize_sync_v2_notebook']['Returns'][number];

interface BootstrapQuery {
  eq(column: 'owner_id', value: string): BootstrapQuery;
  range(from: number, to: number): Promise<{ data: V2NotebookRow[] | null; error: unknown | null }>;
}

interface BootstrapClient {
  auth: { getUser(): Promise<{ data: { user: { id?: string } | null } | null; error: unknown | null }> };
  from(table: 'sync_v2_notebooks'): { select(columns: string): BootstrapQuery };
  rpc(name: 'initialize_sync_v2_notebook', args: InitializeArgs): Promise<{
    data: InitializeRow[] | null;
    error: unknown | null;
  }>;
}

export interface LegacyBootstrapPreview {
  notebook: Notebook;
  completeLeafIds: string[];
  missingSnapshotIds: string[];
  categoryCount: number;
  taskCount: number;
}

function cloneTask(task: Task): Task {
  return { ...task, scheduledDates: [...task.scheduledDates] };
}

function resolveLegacyLeaves(leaves: readonly SyncSnapshot[]): Notebook {
  const categories: Notebook['categories'] = [];
  const categoryById = new Map<string, Notebook['categories'][number]>();
  const taskLocation = new Map<string, string>();
  const ordered = [...leaves].sort((first, second) => (
    first.createdAt.localeCompare(second.createdAt) || first.snapshotId.localeCompare(second.snapshotId)
  ));
  for (const snapshot of ordered) {
    for (const incomingCategory of snapshot.categories) {
      let category = categoryById.get(incomingCategory.id);
      if (!category) {
        category = { id: incomingCategory.id, name: incomingCategory.name, tasks: [] };
        categoryById.set(category.id, category);
        categories.push(category);
      } else {
        category.name = incomingCategory.name;
      }
      for (const incomingTask of incomingCategory.tasks) {
        const previousCategoryId = taskLocation.get(incomingTask.id);
        if (previousCategoryId) {
          const previousCategory = categoryById.get(previousCategoryId);
          if (previousCategory) previousCategory.tasks = previousCategory.tasks.filter(task => task.id !== incomingTask.id);
        }
        category.tasks = category.tasks.filter(task => task.id !== incomingTask.id);
        category.tasks.push(cloneTask(incomingTask));
        taskLocation.set(incomingTask.id, category.id);
      }
    }
  }
  return { categories };
}

function mergeLocalLosslessly(local: Notebook, legacy: Notebook): Notebook {
  const merged = mergeEverything(local, { categories: [] });
  const categoryById = new Map(merged.categories.map(category => [category.id, category]));
  const localTasks = new Map(merged.categories.flatMap(category => category.tasks.map(task => [task.id, task] as const)));
  for (const legacyCategory of legacy.categories) {
    let destination = categoryById.get(legacyCategory.id);
    if (!destination) {
      destination = { id: legacyCategory.id, name: legacyCategory.name, tasks: [] };
      categoryById.set(destination.id, destination);
      merged.categories.push(destination);
    }
    for (const legacyTask of legacyCategory.tasks) {
      const localTask = localTasks.get(legacyTask.id);
      if (localTask) {
        localTask.scheduledDates = [...new Set([...localTask.scheduledDates, ...legacyTask.scheduledDates])].sort();
      } else {
        const task = cloneTask(legacyTask);
        destination.tasks.push(task);
        localTasks.set(task.id, task);
      }
    }
  }
  return merged;
}

function graphLeafIds(snapshots: Map<string, SyncSnapshot>): string[] {
  const parents = new Set<string>();
  for (const snapshot of snapshots.values()) snapshot.parentSnapshotIds.forEach(id => parents.add(id));
  return [...snapshots.keys()].filter(id => !parents.has(id));
}

function missingSnapshotIds(manifest: SyncManifest, snapshots: Map<string, SyncSnapshot>): string[] {
  const missing = new Set<string>();
  manifest.headSnapshotIds.forEach(id => { if (!snapshots.has(id)) missing.add(id); });
  for (const snapshot of snapshots.values()) {
    snapshot.parentSnapshotIds.forEach(id => { if (!snapshots.has(id)) missing.add(id); });
  }
  return [...missing].sort();
}

export function buildLegacyBootstrapPreview(
  local: Notebook,
  manifest: SyncManifest,
  snapshots: Map<string, SyncSnapshot>,
): LegacyBootstrapPreview {
  const completeLeaves = graphLeafIds(snapshots)
    .map(id => snapshots.get(id)!)
    .filter(snapshot => hasCompleteSnapshotAncestry(snapshot, snapshots));
  const notebook = mergeLocalLosslessly(local, resolveLegacyLeaves(completeLeaves));
  return {
    notebook,
    completeLeafIds: completeLeaves
      .sort((first, second) => first.createdAt.localeCompare(second.createdAt) || first.snapshotId.localeCompare(second.snapshotId))
      .map(snapshot => snapshot.snapshotId),
    missingSnapshotIds: missingSnapshotIds(manifest, snapshots),
    categoryCount: notebook.categories.length,
    taskCount: notebook.categories.reduce((total, category) => total + category.tasks.length, 0),
  };
}

function normalizedBootstrapRecord(record: LocalSyncRecord): LocalSyncRecord {
  return { ...structuredClone(record), version: 0, changeSeq: 0 };
}

export function makeV2BootstrapPayload(records: {
  categories: CategorySyncRecord[];
  tasks: TaskSyncRecord[];
}): { categories: Json; tasks: Json } {
  return {
    categories: records.categories.map(normalizedBootstrapRecord) as unknown as Json,
    tasks: records.tasks.map(normalizedBootstrapRecord) as unknown as Json,
  };
}

export class SupabaseRecordBootstrapGateway {
  readonly accountId: string;
  readonly projectRef: string;
  private readonly client: BootstrapClient;

  constructor(accountId: string, options: { client?: BootstrapClient; projectRef?: string } = {}) {
    this.accountId = accountId.trim();
    const configured = options.client ? null : getConfiguredSupabaseProject();
    this.projectRef = (options.projectRef ?? configured?.projectRef ?? '').trim();
    const client = options.client ?? getSupabaseClient();
    if (!this.accountId || !this.projectRef || !client) throw new Error('Supabase record sync is not configured.');
    this.client = client as unknown as BootstrapClient;
  }

  private async assertAccount(): Promise<void> {
    let response;
    try {
      response = await this.client.auth.getUser();
    } catch (error) {
      throw mapSupabaseRecordError(error, 'validate the Supabase session');
    }
    if (response.error) throw mapSupabaseRecordError(response.error, 'validate the Supabase session');
    if (!response.data?.user?.id) throw new RecordTransportError('auth-required', 'Sign in to use cloud sync.', true);
    if (response.data.user.id !== this.accountId) {
      throw new RecordTransportError('binding-mismatch', 'The signed-in account changed before sync started.');
    }
  }

  async inspectNotebook(): Promise<V2NotebookRow | null> {
    await this.assertAccount();
    let response;
    try {
      response = await this.client.from('sync_v2_notebooks')
        .select('notebook_id, owner_id, created_at, updated_at')
        .eq('owner_id', this.accountId)
        .range(0, 1);
    } catch (error) {
      throw mapSupabaseRecordError(error, 'inspect the record notebook');
    }
    if (response.error) throw mapSupabaseRecordError(response.error, 'inspect the record notebook');
    if (!Array.isArray(response.data) || response.data.length > 1) {
      throw new RecordTransportError('invalid', 'Supabase returned an invalid record notebook response.');
    }
    const row = response.data[0] ?? null;
    if (row && row.owner_id !== this.accountId) {
      throw new RecordTransportError('binding-mismatch', 'Supabase returned another account\'s record notebook.');
    }
    return row;
  }

  async initializeNotebook(notebookId: string, records: { categories: CategorySyncRecord[]; tasks: TaskSyncRecord[] }): Promise<void> {
    await this.assertAccount();
    const payload = makeV2BootstrapPayload(records);
    let response;
    try {
      response = await this.client.rpc('initialize_sync_v2_notebook', {
        p_notebook_id: notebookId,
        p_categories: payload.categories,
        p_tasks: payload.tasks,
      });
    } catch (error) {
      throw mapSupabaseRecordError(error, 'initialize the record notebook');
    }
    if (response.error) throw mapSupabaseRecordError(response.error, 'initialize the record notebook');
    if (!Array.isArray(response.data) || response.data.length !== 1
      || response.data[0].notebook_id !== notebookId || response.data[0].owner_id !== this.accountId) {
      throw new RecordTransportError('invalid', 'Supabase returned an invalid record notebook initialization response.');
    }
  }
}

export async function bindRepositoryToRecordSync(
  repository: LocalRepository,
  binding: RecordSyncBinding,
): Promise<RecordSyncState> {
  const model = await repository.readModel();
  const sameBinding = model.syncState.accountId === binding.accountId
    && model.syncState.projectRef === binding.projectRef
    && model.syncState.notebookId === binding.notebookId;
  return repository.transaction(transaction => {
    const current = transaction.getSyncState();
    const next: RecordSyncState = {
      ...current,
      ...binding,
      lastChangeSeq: sameBinding ? current.lastChangeSeq : 0,
      status: 'catching-up',
      lastError: null,
    };
    transaction.setSyncState(next);
    if (!sameBinding) {
      for (const identity of [
        ...model.records.categories.map(record => ({ recordType: record.recordType, id: record.id })),
        ...model.records.tasks.map(record => ({ recordType: record.recordType, id: record.id })),
      ] as const) {
        const local = transaction.getRecord(identity.recordType, identity.id);
        if (local) transaction.applyReconciliation(reconcileRecord(null, local, null));
      }
    }
    return transaction.getSyncState();
  });
}
