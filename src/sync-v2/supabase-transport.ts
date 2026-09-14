import type { Database, Json } from '../../supabase/database.types.ts';
import type { LocalOutboxEntry } from '../local-db/index.ts';
import { getConfiguredSupabaseProject, getSupabaseClient } from '../supabase/client.ts';
import { parseMutationAcknowledgement, parseRemoteSyncRecord } from './validation.ts';
import {
  RecordTransportError,
  type RecordChange,
  type RecordSyncBinding,
  type RecordSyncTransport,
} from './transport.ts';

type V2Functions = Database['public']['Functions'];
type ReadChangesArgs = V2Functions['read_sync_v2_changes']['Args'];
type ReadChangesRow = V2Functions['read_sync_v2_changes']['Returns'][number];
type CategoryMutationArgs = V2Functions['mutate_sync_v2_category']['Args'];
type TaskMutationArgs = V2Functions['mutate_sync_v2_task']['Args'];
type MutationRow = V2Functions['mutate_sync_v2_category']['Returns'][number];

type SupabaseResponse<Value> = { data: Value | null; error: unknown | null };

interface RecordSupabaseClient {
  auth: {
    getUser(): Promise<SupabaseResponse<{ user: { id?: string } | null }>>;
  };
  rpc(functionName: 'read_sync_v2_changes', args: ReadChangesArgs): Promise<SupabaseResponse<ReadChangesRow[]>>;
  rpc(functionName: 'mutate_sync_v2_category', args: CategoryMutationArgs): Promise<SupabaseResponse<MutationRow[]>>;
  rpc(functionName: 'mutate_sync_v2_task', args: TaskMutationArgs): Promise<SupabaseResponse<MutationRow[]>>;
}

export interface SupabaseRecordTransportOptions {
  client?: RecordSupabaseClient;
  projectRef?: string;
  now?: () => number;
}

interface ErrorShape {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}

function errorShape(error: unknown): ErrorShape {
  return typeof error === 'object' && error !== null ? error as ErrorShape : {};
}

function mapError(error: unknown, operation: string): RecordTransportError {
  if (error instanceof RecordTransportError) return error;
  const shaped = errorShape(error);
  const code = typeof shaped.code === 'string' ? shaped.code.toUpperCase() : '';
  const message = typeof shaped.message === 'string' ? shaped.message.toLowerCase() : '';
  const rawStatus = typeof shaped.status === 'number' ? shaped.status : Number(shaped.status);
  const status = Number.isInteger(rawStatus) ? rawStatus : null;
  if (status === 401 || code === 'PGRST301' || /jwt|token|unauthenticated|not authenticated|sign in/.test(message)) {
    return new RecordTransportError('auth-required', 'Sign in to use cloud sync.', true, error);
  }
  if (status === 403 || code === '42501' || /permission|forbidden|row-level security|rls/.test(message)) {
    return new RecordTransportError('permission', 'Cloud sync permission was denied.', false, error);
  }
  if (status === 429 || /rate.?limit|too many requests/.test(message)) {
    return new RecordTransportError('rate-limited', 'Cloud sync is temporarily rate limited.', true, error);
  }
  if (/network|fetch|offline|timeout|timed out|unreachable|connection/.test(message)) {
    return new RecordTransportError('offline', 'Cloud sync is unavailable. Check your connection and try again.', true, error);
  }
  if (code.startsWith('22') || /invalid|malformed|violat/.test(message)) {
    return new RecordTransportError('invalid', 'Supabase rejected invalid record sync data.', false, error);
  }
  if (status !== null && status >= 500) {
    return new RecordTransportError('server', 'Supabase is temporarily unavailable.', true, error);
  }
  return new RecordTransportError('server', `Could not ${operation}.`, true, error);
}

export { mapError as mapSupabaseRecordError };

function invalid(message: string): RecordTransportError {
  return new RecordTransportError('invalid', message, false);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw invalid(`Supabase returned an invalid ${label}.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    throw invalid(`Supabase returned an invalid ${label}.`);
  }
  return parsed as number;
}

function rows<Value>(value: Value[] | null, label: string): Value[] {
  if (!Array.isArray(value)) throw invalid(`Supabase returned an invalid ${label} response.`);
  return value;
}

function oneRow<Value>(value: Value[] | null, label: string): Value {
  const parsed = rows(value, label);
  if (parsed.length !== 1) throw invalid(`Supabase returned an invalid ${label} response.`);
  return parsed[0];
}

function asClient(value: unknown): RecordSupabaseClient {
  return value as RecordSupabaseClient;
}

export class SupabaseRecordTransport implements RecordSyncTransport {
  readonly binding: RecordSyncBinding;
  private readonly client: RecordSupabaseClient;
  private readonly now: () => number;

  constructor(binding: RecordSyncBinding, options: SupabaseRecordTransportOptions = {}) {
    const accountId = binding.accountId.trim();
    const projectRef = binding.projectRef.trim();
    const notebookId = binding.notebookId.trim();
    if (!accountId || !projectRef || !notebookId) throw invalid('Record sync requires a complete binding.');

    const configured = options.client ? null : getConfiguredSupabaseProject();
    const configuredProjectRef = (options.projectRef ?? configured?.projectRef ?? '').trim();
    if (!configuredProjectRef) throw invalid('Supabase sync is not configured.');
    if (configuredProjectRef !== projectRef) {
      throw new RecordTransportError('binding-mismatch', 'The configured Supabase project does not match this sync binding.');
    }
    const client = options.client ?? getSupabaseClient();
    if (!client) throw invalid('Supabase sync is not configured.');
    this.binding = { accountId, projectRef, notebookId };
    this.client = asClient(client);
    this.now = options.now ?? Date.now;
  }

  async assertAuthenticated(): Promise<void> {
    let response: SupabaseResponse<{ user: { id?: string } | null }>;
    try {
      response = await this.client.auth.getUser();
    } catch (error) {
      throw mapError(error, 'validate the Supabase session');
    }
    if (response.error) throw mapError(response.error, 'validate the Supabase session');
    const userId = response.data?.user?.id;
    if (!userId) throw new RecordTransportError('auth-required', 'Sign in to use cloud sync.', true);
    if (userId !== this.binding.accountId) {
      throw new RecordTransportError('binding-mismatch', 'The signed-in account does not match this sync binding.');
    }
  }

  async pullChanges(afterChangeSeq: number, limit: number): Promise<RecordChange[]> {
    if (!Number.isSafeInteger(afterChangeSeq) || afterChangeSeq < 0) throw invalid('The local change cursor is invalid.');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid('The record sync page size is invalid.');
    await this.assertAuthenticated();
    let response: SupabaseResponse<ReadChangesRow[]>;
    try {
      response = await this.client.rpc('read_sync_v2_changes', {
        p_notebook_id: this.binding.notebookId,
        p_after_seq: afterChangeSeq,
        p_limit: limit,
      });
    } catch (error) {
      throw mapError(error, 'read cloud changes');
    }
    if (response.error) throw mapError(response.error, 'read cloud changes');
    return rows(response.data, 'record change').map(row => {
      const changeSeq = positiveInteger(row.change_seq, 'change sequence');
      const recordType = requiredString(row.record_type, 'record type');
      const recordId = requiredString(row.record_id, 'record id');
      const notebookId = requiredString(row.notebook_id, 'notebook id');
      const ownerId = requiredString(row.owner_id, 'owner id');
      if (notebookId !== this.binding.notebookId || ownerId !== this.binding.accountId) {
        throw new RecordTransportError('binding-mismatch', 'Supabase returned a record from another sync binding.');
      }
      const record = parseRemoteSyncRecord(row.payload, {
        expectedNotebookId: this.binding.notebookId,
        expectedOwnerId: this.binding.accountId,
        now: this.now(),
      });
      if (record.recordType !== recordType || record.id !== recordId || record.changeSeq !== changeSeq) {
        throw invalid('Supabase returned mismatched record change metadata.');
      }
      return { changeSeq, record };
    });
  }

  async mutate(entry: LocalOutboxEntry) {
    if (
      entry.accountId !== this.binding.accountId
      || entry.projectRef !== this.binding.projectRef
      || entry.notebookId !== this.binding.notebookId
    ) throw new RecordTransportError('binding-mismatch', 'The queued mutation belongs to another sync binding.');
    await this.assertAuthenticated();
    const payload = entry.record as unknown as Json;
    let response: SupabaseResponse<MutationRow[]>;
    try {
      response = entry.recordType === 'category'
        ? await this.client.rpc('mutate_sync_v2_category', {
          p_notebook_id: entry.notebookId,
          p_category_id: entry.recordId,
          p_mutation_id: entry.mutationId,
          p_expected_version: entry.expectedVersion,
          p_payload: payload,
        })
        : await this.client.rpc('mutate_sync_v2_task', {
          p_notebook_id: entry.notebookId,
          p_task_id: entry.recordId,
          p_mutation_id: entry.mutationId,
          p_expected_version: entry.expectedVersion,
          p_payload: payload,
        });
    } catch (error) {
      throw mapError(error, 'publish the local record');
    }
    if (response.error) throw mapError(response.error, 'publish the local record');
    const row = oneRow(response.data, 'record mutation');
    return parseMutationAcknowledgement({
      mutationId: entry.mutationId,
      outcome: row.outcome,
      recordType: entry.recordType,
      record: row.record,
    }, {
      expectedNotebookId: this.binding.notebookId,
      expectedOwnerId: this.binding.accountId,
      now: this.now(),
    });
  }
}
