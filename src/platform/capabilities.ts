export type RuntimeKind = 'browser' | 'desktop' | 'android' | 'ios';

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

export interface PlatformCapabilities {
  runtime: RuntimeKind;
  nativeLocalStorage: boolean;
  nativeDocuments: boolean;
  documentImportExport: boolean;
  localFolderSync: boolean;
  oneDriveSync: boolean;
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
      localFolderSync: true,
      oneDriveSync: false,
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
      localFolderSync: false,
      oneDriveSync: false,
      desktopClose: false,
      mobileLifecycle: true,
    };
  }
  return {
    runtime,
    nativeLocalStorage: false,
    nativeDocuments: false,
    documentImportExport: true,
    localFolderSync: false,
    oneDriveSync: false,
    desktopClose: false,
    mobileLifecycle: false,
  };
}
