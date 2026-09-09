export const SUPABASE_CALLBACK_URL = 'backlogger://auth/callback';
export const SUPABASE_PROVIDER = 'google' as const;


const PROJECT_HOST_PATTERN = /^([a-z0-9][a-z0-9-]{0,62})\.supabase\.co$/;
const PUBLISHABLE_KEY_PREFIX = 'sb_publishable_';

export interface SupabaseConfig {
  url: string;
  publishableKey: string;
  projectRef: string;
}

export type SupabaseConfigState =
  | { configured: true; config: SupabaseConfig }
  | { configured: false; reason: 'missing' | 'invalid'; message: string };

type RuntimeEnv = Record<string, unknown>;

function defaultRuntimeEnv(): RuntimeEnv {
  // Keep this as a direct `import.meta.env` expression so Vite embeds the
  // client-safe values into production/Tauri bundles at build time.
  return import.meta.env as unknown as RuntimeEnv;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function invalidConfig(message: string): SupabaseConfigState {
  return { configured: false, reason: 'invalid', message };
}

/**
 * Parse only client-safe Supabase configuration. The service-role key and
 * Google client secret are intentionally not accepted here.
 */
export function parseSupabaseConfig(env: RuntimeEnv = defaultRuntimeEnv()): SupabaseConfigState {
  const rawUrl = stringValue(env.VITE_SUPABASE_URL);
  const publishableKey = stringValue(env.VITE_SUPABASE_PUBLISHABLE_KEY);
  if (!rawUrl && !publishableKey) {
    return { configured: false, reason: 'missing', message: 'Sync is not configured.' };
  }
  if (!rawUrl || !publishableKey) {
    return invalidConfig('Sync configuration is incomplete.');
  }
  if (!publishableKey.startsWith(PUBLISHABLE_KEY_PREFIX) || publishableKey.length <= PUBLISHABLE_KEY_PREFIX.length) {
    return invalidConfig('Sync configuration does not contain a publishable key.');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return invalidConfig('Sync configuration contains an invalid Supabase URL.');
  }
  const projectMatch = PROJECT_HOST_PATTERN.exec(parsedUrl.hostname);
  if (
    parsedUrl.protocol !== 'https:'
    || parsedUrl.username
    || parsedUrl.password
    || parsedUrl.port
    || parsedUrl.pathname !== '/'
    || parsedUrl.search
    || parsedUrl.hash
    || !projectMatch
  ) {
    return invalidConfig('Sync configuration must use an HTTPS Supabase project URL.');
  }

  return {
    configured: true,
    config: {
      url: parsedUrl.origin,
      publishableKey,
      projectRef: projectMatch[1],
    },
  };
}

export function isSupabaseConfigConfigured(state: SupabaseConfigState): state is Extract<SupabaseConfigState, { configured: true }> {
  return state.configured;
}
