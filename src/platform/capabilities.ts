export type RuntimeKind = 'browser' | 'desktop' | 'android' | 'ios';

/** Windows uses record/Realtime sync after the staged protocol cutover. */
export const RECORD_SYNC_ENABLED = true as const;

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

export interface PlatformCapabilities {
  runtime: RuntimeKind;
  nativeLocalStorage: boolean;
  nativeDocuments: boolean;
  documentImportExport: boolean;
  /** Provider-neutral cloud-sync entry point. */
  cloudSync: boolean;
  /** Supabase transport is Windows-only until Android callback/lifecycle work is verified. */
  supabaseSync: boolean;
  /** Record-level Supabase sync, currently enabled only on Windows. */
  recordSync: boolean;
  desktopClose: boolean;
  mobileLifecycle: boolean;
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

function runtimeKind(): RuntimeKind {
  if (!isTauriRuntime()) return 'browser';
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent.toLowerCase();
  if (userAgent.includes('android')) return 'android';
  if (userAgent.includes('iphone') || userAgent.includes('ipad') || userAgent.includes('ipod')) return 'ios';
  return 'desktop';
}

export function platformCapabilities(): PlatformCapabilities {
  const runtime = runtimeKind();
  if (runtime === 'desktop') {
    return {
      runtime,
      nativeLocalStorage: true,
      nativeDocuments: true,
      documentImportExport: true,
      cloudSync: true,
      supabaseSync: true,
      recordSync: RECORD_SYNC_ENABLED,
      desktopClose: true,
      mobileLifecycle: false,
    };
  }
  if (runtime === 'android' || runtime === 'ios') {
    return {
      runtime,
      nativeLocalStorage: true,
      nativeDocuments: false,
      documentImportExport: false,
      cloudSync: false,
      supabaseSync: false,
      recordSync: false,
      desktopClose: false,
      mobileLifecycle: true,
    };
  }
  return {
    runtime,
    nativeLocalStorage: false,
    nativeDocuments: false,
    documentImportExport: true,
    cloudSync: false,
    supabaseSync: false,
    recordSync: false,
    desktopClose: false,
    mobileLifecycle: false,
  };
}
