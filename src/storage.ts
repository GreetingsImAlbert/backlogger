import { invoke } from '@tauri-apps/api/core';
import { normalizeDates, parseDate } from './dates.ts';
import type { Category, Notebook, Task } from './model.ts';

export const SCHEMA_VERSION = 1 as const;
const BROWSER_STORAGE_KEY = 'backlogger.document.v1';
const BROWSER_BACKUP_KEY = `${BROWSER_STORAGE_KEY}.bak`;

export type ViewMode = 'all' | 'today';
export type Theme = 'dark' | 'light';

export interface StoredDocument {
  schemaVersion: typeof SCHEMA_VERSION;
  revision: number;
  categories: Category[];
  preferences: { viewMode: ViewMode; theme: Theme };
}

interface TauriWindow extends Window {
  __TAURI_INTERNALS__?: unknown;
}

function isTauriRuntime(): boolean {
  return Boolean((window as TauriWindow).__TAURI_INTERNALS__);
}

export function storageKind(): 'desktop' | 'browser' {
  return isTauriRuntime() ? 'desktop' : 'browser';
}

export async function setNativeTheme(theme: Theme): Promise<void> {
  if (isTauriRuntime()) await invoke('set_app_theme', { theme });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Stored data has an invalid ${field}.`);
  return value;
}

function parseTask(value: unknown, categoryIndex: number, taskIndex: number): Task {
  if (!isRecord(value)) throw new Error(`Stored task ${categoryIndex + 1}.${taskIndex + 1} is invalid.`);
  const scheduledDatesValue = value.scheduledDates;
  if (!Array.isArray(scheduledDatesValue) || scheduledDatesValue.some(item => typeof item !== 'string')) {
    throw new Error(`Stored task ${categoryIndex + 1}.${taskIndex + 1} has invalid work dates.`);
  }
  const deadlineDate = value.deadlineDate;
  if (deadlineDate !== null && typeof deadlineDate !== 'string') {
    throw new Error(`Stored task ${categoryIndex + 1}.${taskIndex + 1} has an invalid deadline.`);
  }
  const normalizedDeadline = deadlineDate === null ? null : (parseDate(deadlineDate), deadlineDate);
  return {
    id: requiredString(value.id, `task ${categoryIndex + 1}.${taskIndex + 1} id`),
    title: requiredString(value.title, `task ${categoryIndex + 1}.${taskIndex + 1} title`),
    scheduledDates: normalizeDates(scheduledDatesValue),
    deadlineDate: normalizedDeadline,
  };
}

function parseCategory(value: unknown, categoryIndex: number): Category {
  if (!isRecord(value)) throw new Error(`Stored category ${categoryIndex + 1} is invalid.`);
  if (!Array.isArray(value.tasks)) throw new Error(`Stored category ${categoryIndex + 1} has invalid tasks.`);
  const tasks = value.tasks.map((task, taskIndex) => parseTask(task, categoryIndex, taskIndex));
  const taskIds = new Set<string>();
  tasks.forEach(task => {
    if (taskIds.has(task.id)) throw new Error(`Stored category ${categoryIndex + 1} has duplicate task ids.`);
    taskIds.add(task.id);
  });
  return {
    id: requiredString(value.id, `category ${categoryIndex + 1} id`),
    name: requiredString(value.name, `category ${categoryIndex + 1} name`),
    tasks,
  };
}

export function parseStoredDocument(value: unknown): StoredDocument {
  if (!isRecord(value)) throw new Error('Stored data is not an object.');
  if (value.schemaVersion !== SCHEMA_VERSION) throw new Error('This saved data uses an unsupported version.');
  if (typeof value.revision !== 'number' || !Number.isInteger(value.revision) || value.revision < 0) {
    throw new Error('Stored data has an invalid revision.');
  }
  if (!Array.isArray(value.categories)) throw new Error('Stored data has invalid categories.');
  if (!isRecord(value.preferences) || (value.preferences.viewMode !== 'all' && value.preferences.viewMode !== 'today')) {
    throw new Error('Stored data has invalid preferences.');
  }
  if (value.preferences.theme !== undefined && value.preferences.theme !== 'dark' && value.preferences.theme !== 'light') {
    throw new Error('Stored data has an invalid theme.');
  }
  const categories = value.categories.map(parseCategory);
  const categoryIds = new Set<string>();
  categories.forEach(category => {
    if (categoryIds.has(category.id)) throw new Error('Stored data has duplicate category ids.');
    categoryIds.add(category.id);
  });
  return {
    schemaVersion: SCHEMA_VERSION,
    revision: value.revision,
    categories,
    preferences: { viewMode: value.preferences.viewMode, theme: value.preferences.theme ?? 'dark' },
  };
}

export function parseStoredText(raw: string): StoredDocument {
  try {
    return parseStoredDocument(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('The selected file is not valid JSON.');
    throw error;
  }
}

export function makeStoredDocument(notebook: Notebook, revision: number, viewMode: ViewMode, theme: Theme = 'dark'): StoredDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    revision,
    categories: notebook.categories.map(category => ({
      ...category,
      tasks: category.tasks.map(task => ({
        ...task,
        scheduledDates: normalizeDates(task.scheduledDates),
        deadlineDate: task.deadlineDate === null ? null : (parseDate(task.deadlineDate), task.deadlineDate),
      })),
    })),
    preferences: { viewMode, theme },
  };
}

export async function readStoredDocument(): Promise<StoredDocument | null> {
  let raw: string | null;
  if (isTauriRuntime()) {
    raw = await invoke<string | null>('load_notebook');
  } else {
    raw = window.localStorage.getItem(BROWSER_STORAGE_KEY);
  }
  if (!raw) return null;
  return parseStoredText(raw);
}

export async function readStoredBackup(): Promise<StoredDocument | null> {
  let raw: string | null;
  if (isTauriRuntime()) {
    raw = await invoke<string | null>('load_notebook_backup');
  } else {
    raw = window.localStorage.getItem(BROWSER_BACKUP_KEY);
  }
  if (!raw) return null;
  return parseStoredText(raw);
}

export async function writeStoredDocument(document: StoredDocument): Promise<void> {
  const raw = JSON.stringify(document, null, 2);
  if (isTauriRuntime()) {
    await invoke('save_notebook', { document: raw });
  } else {
    const current = window.localStorage.getItem(BROWSER_STORAGE_KEY);
    if (current) {
      try {
        parseStoredText(current);
        window.localStorage.setItem(BROWSER_BACKUP_KEY, current);
      } catch {
        // Preserve an unreadable primary record for a later recovery attempt.
      }
    }
    window.localStorage.setItem(BROWSER_STORAGE_KEY, raw);
  }
}

export async function readDocumentFile(path: string): Promise<string> {
  if (!isTauriRuntime()) throw new Error('Native file reading is unavailable in the browser preview.');
  return invoke<string>('read_document_file', { path });
}

export async function writeDocumentFile(path: string, raw: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error('Native file writing is unavailable in the browser preview.');
  await invoke('write_document_file', { path, document: raw });
}
