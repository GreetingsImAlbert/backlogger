import { TransactionalLocalRepository } from './repository.ts';
import type {
  LocalRepository,
  LocalRepositoryDependencies,
  LocalRepositorySnapshot,
  LocalStateStore,
} from './types.ts';

export const BROWSER_LOCAL_REPOSITORY_KEY = 'backlogger.local-repository.v1';
const LEGACY_DOCUMENT_KEY = 'backlogger.document.v1';
const LEGACY_BACKUP_KEY = `${LEGACY_DOCUMENT_KEY}.bak`;

export interface BrowserKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class BrowserLocalStateStore implements LocalStateStore {
  private readonly storage: BrowserKeyValueStorage;

  constructor(storage: BrowserKeyValueStorage) {
    this.storage = storage;
  }

  async load(): Promise<LocalRepositorySnapshot | null> {
    const raw = this.storage.getItem(BROWSER_LOCAL_REPOSITORY_KEY);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as LocalRepositorySnapshot;
    } catch {
      throw new Error('The browser local repository contains invalid JSON.');
    }
  }

  async save(snapshot: LocalRepositorySnapshot): Promise<void> {
    this.storage.setItem(BROWSER_LOCAL_REPOSITORY_KEY, JSON.stringify(snapshot));
  }
}

export async function openBrowserLocalRepository(
  storage: BrowserKeyValueStorage = window.localStorage,
  dependencies: LocalRepositoryDependencies = {},
): Promise<LocalRepository> {
  const repository = new TransactionalLocalRepository(new BrowserLocalStateStore(storage), dependencies);
  const primary = storage.getItem(LEGACY_DOCUMENT_KEY);
  const legacyDocumentJson = primary === null ? storage.getItem(LEGACY_BACKUP_KEY) : primary;
  await repository.initialize(legacyDocumentJson);
  return repository;
}
