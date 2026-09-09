import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../../supabase/database.types.ts';
import { parseSupabaseConfig, type SupabaseConfig, type SupabaseConfigState } from './config.ts';

let cachedConfigState: SupabaseConfigState | null = null;
let cachedConfig: SupabaseConfig | null = null;
let cachedClient: SupabaseClient<Database> | null = null;

export function getSupabaseConfigState(): SupabaseConfigState {
  if (!cachedConfigState) cachedConfigState = parseSupabaseConfig();
  return cachedConfigState;
}

/**
 * Return the one configured client, or null when local-only mode is active.
 * The client owns session persistence; auth state is never copied into sync
 * state or notebook exports.
 */
export function getSupabaseClient(): SupabaseClient<Database> | null {
  const state = getSupabaseConfigState();
  if (!state.configured) return null;
  if (cachedClient) return cachedClient;

  cachedConfig = state.config;
  cachedClient = createClient<Database>(state.config.url, state.config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: 'pkce',
      storageKey: `backlogger.auth.${state.config.projectRef}`,
    },
  });
  return cachedClient;
}

export function getConfiguredSupabaseProject(): SupabaseConfig | null {
  if (!cachedConfig) {
    const state = getSupabaseConfigState();
    cachedConfig = state.configured ? state.config : null;
  }
  return cachedConfig;
}
