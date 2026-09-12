import { isTauriRuntime } from '../platform/capabilities.ts';
import { openBrowserLocalRepository } from './browser.ts';
import { openTauriLocalRepository } from './sqlite.ts';
import type { LocalRepository, LocalRepositoryDependencies } from './types.ts';

export * from './types.ts';
export * from './repository.ts';
export * from './browser.ts';
export * from './sqlite.ts';

/**
 * Dormant Milestone 2 factory. The active UI intentionally does not call this
 * until the repository cutover milestone.
 */
export function openLocalRepository(
  dependencies: LocalRepositoryDependencies = {},
): Promise<LocalRepository> {
  return isTauriRuntime()
    ? openTauriLocalRepository(dependencies)
    : openBrowserLocalRepository(window.localStorage, dependencies);
}
