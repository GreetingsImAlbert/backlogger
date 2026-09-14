import type { RecordSyncState } from './types.ts';

export interface RecordSyncStatusPresentation {
  label: 'Not logged in' | 'Paused' | 'Syncing…' | 'Offline' | 'Sync failed' | 'Connected';
  detail: string;
}

function looksOffline(message: string | null): boolean {
  return Boolean(message && /offline|network|connection (?:closed|timed out)|could not reach/i.test(message));
}

export function presentRecordSyncStatus(
  state: RecordSyncState | null,
  outboxCount: number,
  connected: boolean,
): RecordSyncStatusPresentation {
  if (!connected || !state) return { label: 'Not logged in', detail: 'Log in with Google, then start sync for this notebook.' };
  if (state.status === 'paused') {
    return {
      label: 'Paused',
      detail: `${outboxCount} local change${outboxCount === 1 ? '' : 's'} waiting while sync is paused.`,
    };
  }
  if (state.status === 'catching-up') return { label: 'Syncing…', detail: 'Reconciling local and cloud record changes.' };
  if (state.status === 'degraded' && looksOffline(state.lastError)) {
    return { label: 'Offline', detail: state.lastError ?? 'Cloud sync is offline; local editing remains available.' };
  }
  if (state.status === 'error' || state.status === 'degraded') {
    return { label: 'Sync failed', detail: state.lastError ?? 'Cloud sync could not complete.' };
  }
  return {
    label: 'Connected',
    detail: outboxCount
      ? `${outboxCount} local change${outboxCount === 1 ? '' : 's'} waiting to upload.`
      : 'Local changes are saved immediately and synced in the background.',
  };
}
