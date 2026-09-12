import { isTauriRuntime } from '../platform/capabilities.ts';
import {
  openBrowserLocalRepository,
  openBrowserLocalRepositoryFromLegacyBackup,
  readBrowserLegacyRecoveryCandidate,
} from './browser.ts';
import {
  openTauriLocalRepository,
  openTauriLocalRepositoryFromLegacyBackup,
  readTauriLegacyRecoveryCandidate,
} from './sqlite.ts';
import type { PortableDocument } from '../storage.ts';
import type { LocalRepository, LocalRepositoryDependencies } from './types.ts';

export * from './types.ts';
export * from './repository.ts';
export * from './browser.ts';
export * from './sqlite.ts';

export function openLocalRepository(
  dependencies: LocalRepositoryDependencies = {},
): Promise<LocalRepository> {
  return isTauriRuntime()
    ? openTauriLocalRepository(dependencies)
    : openBrowserLocalRepository(window.localStorage, dependencies);
}

export function readLegacyRecoveryCandidate(): Promise<PortableDocument | null> {
  return isTauriRuntime()
    ? readTauriLegacyRecoveryCandidate()
    : Promise.resolve(readBrowserLegacyRecoveryCandidate(window.localStorage));
}

export function openLocalRepositoryFromLegacyBackup(
  dependencies: LocalRepositoryDependencies = {},
): Promise<LocalRepository> {
  return isTauriRuntime()
    ? openTauriLocalRepositoryFromLegacyBackup(dependencies)
    : openBrowserLocalRepositoryFromLegacyBackup(window.localStorage, dependencies);
}
