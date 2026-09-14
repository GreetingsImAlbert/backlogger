export type RecordSyncProtocol = 'legacy' | 'v2';

/**
 * The default release uses v2. An explicit legacy build remains available for
 * one rollout window; malformed explicit values fail closed to legacy.
 */
export function resolveRecordSyncProtocol(value: unknown): RecordSyncProtocol {
  if (value === undefined || value === null || value === '') return 'v2';
  return typeof value === 'string' && value.trim().toLowerCase() === 'v2' ? 'v2' : 'legacy';
}

export const RECORD_SYNC_PROTOCOL = resolveRecordSyncProtocol(import.meta.env?.VITE_RECORD_SYNC_PROTOCOL);
export const RECORD_SYNC_ENABLED = RECORD_SYNC_PROTOCOL === 'v2';
