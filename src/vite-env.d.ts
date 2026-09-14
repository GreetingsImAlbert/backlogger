/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  readonly VITE_RECORD_SYNC_PROTOCOL?: 'v2' | 'legacy';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
