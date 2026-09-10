import './style.css';
import { open as openNativeFile, save as saveNativeFile } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { compactDate, compactDateList, dateLabel, localToday, normalizeDates, parseDate, shiftDate, weekStart } from './dates';
import type { Category, Notebook, Task } from './model';
import { platformCapabilities } from './platform/capabilities';
import { reorderCategories, reorderTasksWithinCategory, type DropPosition } from './reorder';
import { makeStoredDocument, parseStoredText, readDocumentFile, readStoredBackup, readStoredDocument, setNativeTheme, storageKind, writeDocumentFile, writeStoredDocument, type StoredDocument, type Theme, type ViewMode } from './storage';
import { hasCompleteSnapshotAncestry, isSnapshotAncestor, loadSyncState, makeCheckpointSnapshot, makeSyncManifest, makeSyncSnapshot, makeSyncState, mergeEverything, notebookFingerprint, notebookFromSnapshot, parseSyncSnapshot, saveSyncState, snapshotFingerprint, snapshotLeaves, storedDocumentFromSyncSnapshot, SYNC_SNAPSHOT_RETENTION_LIMIT, type SyncManifest, type SyncSnapshot, type SyncState, type SupabaseLocation } from './sync';
import { SyncCoordinator } from './sync/coordinator';
import { SupabaseSyncTransport } from './sync/supabase-transport';
import type { SyncTransport } from './sync/transport';
import { cancelGoogleSignIn, getAuthState, initializeAuth, signOut as signOutAuth, startGoogleSignIn, subscribeAuthState, type AuthState } from './supabase/auth';
import { getConfiguredSupabaseProject } from './supabase/client';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App container is missing.');
const capabilities = platformCapabilities();
let notebook: Notebook = { categories: [] };
let hasUnsavedChanges = false;
let viewMode: ViewMode = 'all';
let theme: Theme = 'dark';
let revision = 0;
let storageReady = false;
let storageBlocked = false;
let saveSequence = 0;
let saveQueue: Promise<void> = Promise.resolve();
let undoState: Notebook | null = null;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
let syncState: SyncState = makeSyncState('pending');
let syncReady = false;
let syncLoadError: string | null = null;
let syncQueue: Promise<void> = Promise.resolve();
let syncDialogElement: HTMLDialogElement | null = null;
let syncDialogRefresh: (() => void) | null = null;
let syncDeferred = false;
let authState: AuthState = getAuthState();
let signInStartedAt: number | null = null;
let cloudInspection: { accountId: string; manifest: SyncManifest | null; error: string | null } | null = null;
let cloudInspectionInFlight: Promise<void> | null = null;
type SessionPhase = 'loading' | 'fetching' | 'ready' | 'offline' | 'closing';
interface AvailableUpdate {
  snapshot: SyncSnapshot;
  branchCount: number;
}
let sessionPhase: SessionPhase = 'loading';
let sessionContentDirty = false;
let statusMessage = '';
let statusDetailMessage = '';
let availableUpdate: AvailableUpdate | null = null;
let ignoredUpdateIds = new Set<string>();
let closeInProgress = false;
let syncRetentionMessage = '';
let sessionFetchInFlight: Promise<void> | null = null;
type DragState =
  | { kind: 'category'; categoryId: string }
  | { kind: 'task'; categoryId: string; taskId: string };
let dragState: DragState | null = null;
let dropTarget: HTMLElement | null = null;
let activeDropPosition: DropPosition | null = null;
let dragPointerId: number | null = null;
let dragHandleElement: HTMLElement | null = null;
const SYNC_CHECK_TIMEOUT_MS = 8_000;
const CLOSE_OPERATION_TIMEOUT_MS = 12_000;
const CLOSE_SNAPSHOT_TIMEOUT_MS = 2_000;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface ScrollPosition {
  left: number;
  top: number;
}

function readScrollPosition(): ScrollPosition {
  return { left: window.scrollX, top: window.scrollY };
}

function restoreScrollPosition(position: ScrollPosition) {
  window.scrollTo(position.left, position.top);
}

function focusWithoutScrolling(node: HTMLElement | null) {
  node?.focus({ preventScroll: true });
}

function button(text: string, action: () => void, className = 'quiet-button') {
  const node = element('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

const icons = {
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  grip: '<path d="M8 6h.01M8 12h.01M8 18h.01M16 6h.01M16 12h.01M16 18h.01"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  moon: '<path d="M20 14a8 8 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z"/>',
};
function decorateIcon(node: HTMLElement, icon: keyof typeof icons, label: string) {
  node.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[icon]}</svg>`;
  node.setAttribute('aria-label', label);
  node.title = label;
}
function iconButton(icon: keyof typeof icons, label: string, action: () => void) {
  const node = button('', action, 'icon-button');
  decorateIcon(node, icon, label);
  return node;
}
function actionMenu(label: string, items: HTMLButtonElement[]) {
  const menu = element('details', 'action-menu');
  const trigger = element('summary', 'icon-button');
  decorateIcon(trigger, 'more', label);
  const panel = element('div', 'menu-panel');
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', label);
  items.forEach(item => {
    item.addEventListener('click', () => { menu.open = false; });
    panel.append(item);
  });
  menu.append(trigger, panel);
  return menu;
}

function editingIsReady(): boolean {
  return storageReady && !storageBlocked && !closeInProgress && (sessionPhase === 'ready' || sessionPhase === 'offline');
}

function clearDropIndicator() {
  document.querySelectorAll<HTMLElement>('.drop-before, .drop-after').forEach(node => {
    node.classList.remove('drop-before', 'drop-after');
  });
  dropTarget = null;
  activeDropPosition = null;
}

function clearDragSession() {
  if (dragPointerId !== null && dragHandleElement?.hasPointerCapture(dragPointerId)) {
    dragHandleElement.releasePointerCapture(dragPointerId);
  }
  clearDropIndicator();
  document.querySelectorAll<HTMLElement>('.is-dragging').forEach(node => node.classList.remove('is-dragging'));
  dragState = null;
  dragPointerId = null;
  dragHandleElement = null;
}

function dropPositionFor(clientY: number, target: HTMLElement): DropPosition {
  const bounds = target.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
}

function showDropIndicator(target: HTMLElement, position: DropPosition) {
  if (dropTarget === target && activeDropPosition === position) return;
  clearDropIndicator();
  dropTarget = target;
  activeDropPosition = position;
  target.classList.add(position === 'before' ? 'drop-before' : 'drop-after');
}

function startPointerDrag(event: PointerEvent, source: HTMLElement, state: DragState, handle: HTMLElement) {
  if (event.button !== 0 || !editingIsReady()) {
    event.preventDefault();
    return;
  }
  event.preventDefault();
  clearDragSession();
  dragState = state;
  dragPointerId = event.pointerId;
  dragHandleElement = handle;
  source.classList.add('is-dragging');
  handle.setPointerCapture(event.pointerId);
}

function dragHandle(label: string, source: HTMLElement, state: DragState, enabled: boolean) {
  const handle = element('button', 'icon-button drag-handle');
  handle.type = 'button';
  handle.draggable = false;
  handle.disabled = !enabled;
  decorateIcon(handle, 'grip', label);
  handle.addEventListener('pointerdown', event => startPointerDrag(event, source, state, handle));
  return handle;
}

function updatePointerDrop(event: PointerEvent) {
  if (!dragState) return;
  event.preventDefault();
  const hovered = document.elementFromPoint(event.clientX, event.clientY);
  if (!hovered || !editingIsReady()) {
    clearDropIndicator();
    return;
  }

  if (dragState.kind === 'category') {
    const target = hovered.closest<HTMLElement>('.category');
    const targetCategoryId = target?.dataset.categoryId;
    if (!target || !targetCategoryId) {
      clearDropIndicator();
      return;
    }
    const position = dropPositionFor(event.clientY, target);
    if (reorderCategories(notebook.categories, dragState.categoryId, targetCategoryId, position)) {
      showDropIndicator(target, position);
    } else {
      clearDropIndicator();
    }
    return;
  }

  const target = hovered.closest<HTMLElement>('.task');
  const targetCategoryId = target?.dataset.categoryId;
  const targetTaskId = target?.dataset.taskId;
  if (!target || !targetCategoryId || !targetTaskId || dragState.categoryId !== targetCategoryId) {
    clearDropIndicator();
    return;
  }
  const position = dropPositionFor(event.clientY, target);
  if (reorderTasksWithinCategory(
    notebook.categories,
    dragState.categoryId,
    dragState.taskId,
    targetCategoryId,
    targetTaskId,
    position,
  )) {
    showDropIndicator(target, position);
  } else {
    clearDropIndicator();
  }
}

function commitPointerDrop(state: DragState, target: HTMLElement, position: DropPosition) {
  if (state.kind === 'category') {
    const targetCategoryId = target.dataset.categoryId;
    const sourceCategory = notebook.categories.find(category => category.id === state.categoryId);
    const targetCategory = notebook.categories.find(category => category.id === targetCategoryId);
    const reordered = targetCategoryId
      ? reorderCategories(notebook.categories, state.categoryId, targetCategoryId, position)
      : null;
    if (!sourceCategory || !targetCategory || !reordered) return;
    commit(() => {
      notebook.categories = reordered;
    }, `Moved ${sourceCategory.name} ${position} ${targetCategory.name}.`);
    return;
  }

  const targetCategoryId = target.dataset.categoryId;
  const targetTaskId = target.dataset.taskId;
  const category = notebook.categories.find(item => item.id === state.categoryId);
  const sourceTask = category?.tasks.find(task => task.id === state.taskId);
  const targetTask = category?.tasks.find(task => task.id === targetTaskId);
  const reordered = targetCategoryId && targetTaskId
    ? reorderTasksWithinCategory(
      notebook.categories,
      state.categoryId,
      state.taskId,
      targetCategoryId,
      targetTaskId,
      position,
    )
    : null;
  if (!sourceTask || !targetTask || !reordered) return;
  commit(() => {
    notebook.categories = reordered;
  }, `Moved ${sourceTask.title} ${position} ${targetTask.title}.`);
}

function finishPointerDrag(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragPointerId) return;
  event.preventDefault();
  updatePointerDrop(event);
  const state = dragState;
  const target = dropTarget;
  const position = activeDropPosition;
  clearDragSession();
  if (target && position) commitPointerDrop(state, target, position);
}

document.addEventListener('pointermove', updatePointerDrop, { passive: false });
document.addEventListener('pointerup', finishPointerDrag, { passive: false });
document.addEventListener('pointercancel', clearDragSession);

document.addEventListener('click', event => {
  document.querySelectorAll<HTMLDetailsElement>('.action-menu[open]').forEach(menu => {
    if (!menu.contains(event.target as Node)) menu.open = false;
  });
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  document.querySelectorAll<HTMLDetailsElement>('.action-menu[open]').forEach(menu => {
    menu.open = false;
    focusWithoutScrolling(menu.querySelector('summary'));
  });
});

const main = element('main', 'notebook');
const header = element('header', 'app-header');
const titleBar = element('div', 'title-bar');
titleBar.append(element('h1', '', 'Backlogger'));
const headerActions = element('div', 'header-actions');
const themeButton = iconButton('sun', 'Switch to light mode', () => {
  theme = theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  queueSave(false);
});
headerActions.append(themeButton);
titleBar.append(headerActions);
header.append(titleBar);
const viewSwitch = element('div', 'view-switch');
viewSwitch.setAttribute('role', 'group');
viewSwitch.setAttribute('aria-label', 'Task view');
const allView = button('All', () => setView('all'), 'view-button');
const todayView = button('Today', () => setView('today'), 'view-button');
const tomorrowView = button('Tomorrow', () => setView('tomorrow'), 'view-button');
viewSwitch.append(allView, todayView, tomorrowView);
header.append(viewSwitch);
const notice = element('aside', 'preview-notice');
notice.setAttribute('aria-label', 'Storage status');
const noticeTitle = element('strong');
const noticeDetail = element('span');
const noticeActions = element('span', 'storage-actions');
const recoverButton = button('Recover backup', () => void recoverBackup(), 'quiet-button');
const retrySaveButton = button('Retry save', () => queueSave(), 'quiet-button');
recoverButton.hidden = true;
retrySaveButton.hidden = true;
noticeActions.append(recoverButton, retrySaveButton);
notice.append(noticeTitle, noticeDetail, noticeActions);
const statusBar = element('aside', 'status-bar');
statusBar.setAttribute('aria-label', 'Activity status');
const status = element('div', 'status');
status.setAttribute('role', 'status');
status.setAttribute('aria-live', 'polite');
const statusText = element('span');
const statusInfo = element('span', 'status-info');
statusInfo.tabIndex = 0;
statusInfo.setAttribute('role', 'img');
statusInfo.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>';
statusInfo.hidden = true;
status.append(statusText, statusInfo);
const statusActions = element('div', 'status-actions');
const fetchUpdateButton = button('Fetch', () => void fetchAvailableUpdate(), 'quiet-button');
const mergeUpdateButton = button('Merge', () => void mergeAvailableUpdate(), 'quiet-button');
const retryFetchButton = button('Retry fetch', () => void retrySessionFetch(), 'quiet-button');
fetchUpdateButton.hidden = true;
mergeUpdateButton.hidden = true;
retryFetchButton.hidden = true;
statusActions.append(fetchUpdateButton, mergeUpdateButton, retryFetchButton);
statusBar.append(status, statusActions);
const list = element('div', 'categories');
const addCategory = button('+ Add category', () => editCategory(), 'add-category');
const exportButton = button('Export', exportCurrentDocument);
const importButton = button('Import', () => void startImport());
const syncButton = button('Sync', () => void openSyncDialog());
const importInput = element('input');
importInput.type = 'file';
importInput.accept = 'application/json,.json';
importInput.hidden = true;
importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (file) void inspectImport(file);
});
const undoButton = button('Undo', () => {
  if (!undoState || storageBlocked || closeInProgress || (sessionPhase !== 'ready' && sessionPhase !== 'offline')) return;
  notebook = undoState;
  clearUndo();
  sessionContentDirty = true;
  render();
  queueSave();
  setStatusMessage('Deletion undone.');
  focusWithoutScrolling(addCategory);
});
undoButton.hidden = true;
const actions = element('div', 'bottom-actions');
headerActions.append(actionMenu('Backlogger options', [syncButton, importButton, exportButton]));
actions.append(addCategory, importInput, undoButton);
main.append(header, notice, statusBar, list, actions);
root.append(main);

function setStatusMessage(message: string) {
  statusMessage = message;
  statusDetailMessage = '';
  renderStatusBar();
}

function setSyncStatusMessage(detail: string) {
  statusMessage = 'Syncing...';
  statusDetailMessage = detail;
  renderStatusBar();
}

function renderStatusBar() {
  const update = availableUpdate;
  const message = update
    ? update.branchCount > 1 ? `${update.branchCount} shared updates available.` : 'Shared update available.'
    : statusMessage;
  statusText.textContent = message;
  statusInfo.hidden = Boolean(update) || !statusDetailMessage || !message;
  statusInfo.title = statusDetailMessage;
  statusInfo.setAttribute('aria-label', `Sync details: ${statusDetailMessage}`);
  status.hidden = !message;
  fetchUpdateButton.hidden = !update;
  mergeUpdateButton.hidden = !update;
  retryFetchButton.hidden = sessionPhase !== 'offline' || !syncState.lastError;
  const editingReady = sessionPhase === 'ready' || sessionPhase === 'offline';
  fetchUpdateButton.disabled = !editingReady;
  mergeUpdateButton.disabled = !editingReady;
  retryFetchButton.disabled = sessionPhase === 'fetching' || sessionPhase === 'closing';
  statusBar.hidden = !message && statusActions.querySelector('button:not([hidden])') === null;
}

function setStorageNotice(title: string, detail: string) {
  noticeTitle.textContent = title;
  noticeDetail.textContent = detail;
  notice.hidden = title !== 'Save failed' && title !== 'Saved data needs attention';
}

function applyTheme() {
  document.documentElement.dataset.theme = theme;
  decorateIcon(themeButton, theme === 'dark' ? 'sun' : 'moon', `Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`);
  void setNativeTheme(theme).catch(error => console.error('Could not update window theme', error));
}

function setView(mode: ViewMode) {
  viewMode = mode;
  render();
  queueSave(false);
}

function taskCount(categories: Notebook['categories']): number {
  return categories.reduce((total, category) => total + category.tasks.length, 0);
}

async function exportCurrentDocument() {
  if (!capabilities.documentImportExport) {
    setStatusMessage('Import and export will be available on Android in a later milestone.');
    return;
  }
  const stored = makeStoredDocument(notebook, revision, viewMode, theme);
  const raw = JSON.stringify(stored, null, 2);
  try {
    if (capabilities.nativeDocuments) {
      const path = await saveNativeFile({
        title: 'Export Backlogger',
        defaultPath: `backlogger-${localToday()}.json`,
        filters: [{ name: 'Backlogger JSON', extensions: ['json'] }],
      });
      if (!path) return;
      await writeDocumentFile(path, raw);
    } else {
      const blob = new Blob([raw], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = element('a');
      link.href = url;
      link.download = `backlogger-${localToday()}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    }
    setStatusMessage(`Exported ${taskCount(stored.categories)} task(s) in ${stored.categories.length} categor${stored.categories.length === 1 ? 'y' : 'ies'}.`);
  } catch (error) {
    setStatusMessage(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface ImportPayload {
  document: StoredDocument;
  syncSnapshot: SyncSnapshot | null;
}

function parseImportPayload(raw: string): ImportPayload {
  try {
    return { document: parseStoredText(raw), syncSnapshot: null };
  } catch (storedError) {
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw storedError;
    }
    try {
      const snapshot = parseSyncSnapshot(value, 'Sync snapshot');
      return { document: storedDocumentFromSyncSnapshot(snapshot, viewMode, theme), syncSnapshot: snapshot };
    } catch {
      throw storedError;
    }
  }
}

function showImportDialog(fileName: string, imported: StoredDocument, syncSnapshot: SyncSnapshot | null = null) {
  const editor = openDialog('Import backlog?');
  editor.body.append(
    element('p', '', `Import “${fileName}” and replace the current list?`),
    element('p', 'import-summary', `${imported.categories.length} categor${imported.categories.length === 1 ? 'y' : 'ies'} and ${taskCount(imported.categories)} task(s) were validated.`),
  );
  if (syncSnapshot) {
    editor.body.append(element('p', 'advisory', `This is a Backlogger sync snapshot from ${formatSyncCheckTime(syncSnapshot.createdAt) || 'an earlier time'}. It was converted to a normal local import; device theme and view stay local.`));
  }
  editor.save.textContent = syncSnapshot ? 'Import snapshot and save' : 'Import and save';
  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    commit(() => {
      notebook = { categories: imported.categories };
      viewMode = imported.preferences.viewMode;
      revision = Math.max(revision, imported.revision);
      if (syncSnapshot && capabilities.supabaseSync && hasCloudBinding() && syncState.status !== 'disconnected') {
        syncState.currentSnapshotId = syncSnapshot.snapshotId;
        syncState.knownHeadSnapshotIds = [...new Set([...syncState.knownHeadSnapshotIds, syncSnapshot.snapshotId])];
        syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, syncSnapshot.snapshotId])];
        syncState.pendingSnapshots = [];
        syncState.mergeParentSnapshotIds = [];
        syncState.conflicts = [];
        syncState.lastError = null;
      }
      storageBlocked = false;
      recoverButton.hidden = true;
    }, syncSnapshot ? `Recovered ${fileName} as a local import.` : `Imported ${fileName}.`, true);
    editor.dialog.close();
  });
}

async function inspectImport(file: File) {
  try {
    const imported = parseImportPayload(await file.text());
    showImportDialog(file.name, imported.document, imported.syncSnapshot);
  } catch (error) {
    setStatusMessage(`Import rejected: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function startImport() {
  if (!capabilities.documentImportExport) {
    setStatusMessage('Import and export will be available on Android in a later milestone.');
    return;
  }
  if (storageKind() !== 'desktop') {
    importInput.click();
    return;
  }
  try {
    const path = await openNativeFile({
      title: 'Import Backlogger',
      multiple: false,
      directory: false,
      filters: [{ name: 'Backlogger JSON', extensions: ['json'] }],
    });
    if (typeof path !== 'string') return;
    const imported = parseImportPayload(await readDocumentFile(path));
    showImportDialog(path.split(/[\\/]/).pop() ?? path, imported.document, imported.syncSnapshot);
  } catch (error) {
    setStatusMessage(`Import failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function syncCheckTime(): string {
  return new Date().toISOString();
}

function formatSyncCheckTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function startSyncCheck(): string {
  const checkedAt = syncCheckTime();
  syncState.lastCheckedAt = checkedAt;
  return checkedAt;
}

function finishSyncCheck(checkedAt: string) {
  syncState.lastCheckedAt = checkedAt;
  syncState.lastSuccessfulCheckAt = checkedAt;
  syncState.lastError = null;
}

function enqueueSyncMutation<T>(action: () => Promise<T>): Promise<T> {
  const next = syncQueue.catch(() => undefined).then(action);
  syncQueue = next.then(() => undefined, () => undefined);
  return next;
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function withSyncTimeout<T>(operation: Promise<T>): Promise<T> {
  return withTimeout(operation, SYNC_CHECK_TIMEOUT_MS, 'The cloud sync check timed out.');
}

function cloudLocation(location: SyncState['location'] = syncState.location): SupabaseLocation | null {
  return location?.kind === 'supabase' ? location : null;
}

function hasCloudBinding(): boolean {
  return capabilities.supabaseSync && Boolean(cloudLocation()) && syncState.status !== 'disconnected';
}

function currentSupabaseLocation(): SupabaseLocation {
  if (!capabilities.supabaseSync) throw new Error('Cloud sync is unavailable on this device.');
  if (authState.status !== 'signed-in' || !authState.userId) throw new Error('Log in to sync.');
  const project = getConfiguredSupabaseProject();
  if (!project) throw new Error('Sync is not configured.');
  return { kind: 'supabase', accountId: authState.userId, projectRef: project.projectRef };
}

function syncTransportFor(location: SyncState['location'] = syncState.location): SyncTransport | null {
  if (!location || location.kind !== 'supabase' || !capabilities.supabaseSync) return null;
  return new SupabaseSyncTransport(location);
}

function syncCoordinatorFor(location: SyncState['location'] = syncState.location): SyncCoordinator | null {
  const transport = syncTransportFor(location);
  return transport ? new SyncCoordinator(transport, syncState.notebookId) : null;
}

function syncStatusLabel(): string {
  if (!capabilities.cloudSync) return 'Not logged in';
  if (!syncReady) return syncLoadError ? 'Unavailable' : 'Loading…';
  if (authState.status === 'signing-in') return 'Signing in';
  if (authState.status !== 'signed-in' || !syncState.location || syncState.status === 'disconnected') return 'Not logged in';
  if (syncState.status === 'paused') return 'Paused';
  if (syncState.conflicts.length) return 'Conflicts';
  if (syncState.lastError) return 'Offline';
  return 'Connected';
}

function syncStatusDetail(): string {
  if (!capabilities.cloudSync) return 'Cloud sync is unavailable on this device.';
  if (syncLoadError) return `Sync settings could not be loaded: ${syncLoadError}`;
  if (!authState.configured) return 'Sync is not configured for this build.';
  if (authState.status === 'signing-in') return 'Complete Google sign-in in your browser.';
  if (authState.status !== 'signed-in' || !syncState.location || syncState.status === 'disconnected') return 'Log in with Google to sync this notebook.';
  const pending = syncState.pendingSnapshots.length;
  if (syncState.conflicts.length) return `${syncState.conflicts.length} conflict${syncState.conflicts.length === 1 ? '' : 's'} need attention.`;
  if (syncState.lastError) return `Cloud sync is offline: ${syncState.lastError}`;
  if (syncState.status === 'paused') return `${pending} pending snapshot${pending === 1 ? '' : 's'} saved locally.`;
  const checked = formatSyncCheckTime(syncState.lastSuccessfulCheckAt);
  const checkedDetail = checked ? ` Last cloud check ${checked}.` : '';
  const retentionDetail = syncRetentionMessage ? ` ${syncRetentionMessage}` : '';
  return pending
    ? `${pending} snapshot${pending === 1 ? '' : 's'} waiting to sync.${checkedDetail}${retentionDetail}`
    : `Local changes publish to Supabase when sync runs.${checkedDetail}${retentionDetail}`;
}

async function compactSyncHistory(coordinator: SyncCoordinator): Promise<boolean> {
  if (!syncState.notebookId || syncState.pendingSnapshots.length || syncState.conflicts.length) return false;
  let createdSnapshots: SyncSnapshot[] = [];
  let manifestPublished = false;
  try {
    const snapshots = await coordinator.readSnapshotIndex();
    if (snapshots.size <= SYNC_SNAPSHOT_RETENTION_LIMIT) return false;
    const originalResource = await coordinator.readManifestResource();
    const originalManifest = originalResource?.manifest ?? null;
    if (!originalManifest || originalManifest.notebookId !== syncState.notebookId) return false;
    if (originalManifest.headSnapshotIds.length !== 1 || originalManifest.headSnapshotIds[0] !== (syncState.currentSnapshotId ?? syncState.lastPublishedSnapshotId)) return false;
    assertCompleteRemoteHistory(originalManifest, snapshots);
    const currentId = syncState.currentSnapshotId ?? syncState.lastPublishedSnapshotId;
    const leaves = snapshotLeaves(snapshots);
    if (!currentId || leaves.length !== 1 || leaves[0].snapshotId !== currentId) return false;
    const lineage: SyncSnapshot[] = [];
    const visited = new Set<string>();
    let cursor: SyncSnapshot | undefined = leaves[0];
    while (cursor) {
      if (visited.has(cursor.snapshotId) || cursor.parentSnapshotIds.length > 1) return false;
      visited.add(cursor.snapshotId);
      lineage.push(cursor);
      const parentId: string | undefined = cursor.parentSnapshotIds[0];
      cursor = parentId ? snapshots.get(parentId) : undefined;
      if (parentId && !cursor) return false;
    }
    lineage.reverse();
    if (lineage.length !== snapshots.size) return false;

    const retainedDescendantCount = SYNC_SNAPSHOT_RETENTION_LIMIT - 1;
    const boundaryIndex = lineage.length - retainedDescendantCount - 1;
    if (boundaryIndex < 0) return false;
    const boundary = lineage[boundaryIndex];
    const checkpointDocument = storedDocumentFromSyncSnapshot(boundary, viewMode, theme);
    const checkpoint = makeCheckpointSnapshot(checkpointDocument, syncState);
    createdSnapshots = [checkpoint];
    let parentId = checkpoint.snapshotId;
    for (const original of lineage.slice(boundaryIndex + 1)) {
      const rebased: SyncSnapshot = {
        protocolVersion: original.protocolVersion,
        type: 'snapshot',
        snapshotId: crypto.randomUUID(),
        notebookId: original.notebookId,
        deviceId: original.deviceId,
        parentSnapshotIds: [parentId],
        createdAt: original.createdAt,
        revision: original.revision,
        categories: original.categories.map(category => ({
          ...category,
          tasks: category.tasks.map(task => ({ ...task, scheduledDates: [...task.scheduledDates] })),
        })),
      };
      createdSnapshots.push(rebased);
      parentId = rebased.snapshotId;
    }
    for (const snapshot of createdSnapshots) await coordinator.createSnapshotIfNeeded(snapshot);

    const latestSnapshots = await coordinator.readSnapshotIndex();
    const latestResource = await coordinator.readManifestResource();
    const latestManifest = latestResource?.manifest ?? null;
    const manifestsMatch = latestManifest
      && JSON.stringify([...latestManifest.headSnapshotIds].sort()) === JSON.stringify([...originalManifest.headSnapshotIds].sort())
      && JSON.stringify([...latestManifest.prunedSnapshotIds].sort()) === JSON.stringify([...originalManifest.prunedSnapshotIds].sort());
    const unchangedHistory = latestManifest
      && latestManifest.notebookId === syncState.notebookId
      && manifestsMatch
      && latestSnapshots.size === snapshots.size + createdSnapshots.length
      && [...snapshots.keys()].every(snapshotId => latestSnapshots.has(snapshotId));
    if (!unchangedHistory) {
      for (const snapshot of createdSnapshots) await coordinator.deleteSnapshot(snapshot.snapshotId);
      return false;
    }

    const newHead = createdSnapshots.at(-1)!;
    await coordinator.writeManifest({
      ...latestManifest,
      headSnapshotIds: [newHead.snapshotId],
      prunedSnapshotIds: [...new Set([...latestManifest.prunedSnapshotIds, ...snapshots.keys()])],
    }, latestResource?.remote.version);
    manifestPublished = true;
    for (const snapshotId of snapshots.keys()) {
      try {
        await coordinator.deleteSnapshot(snapshotId);
      } catch (error) {
        console.warn(`Could not remove old sync snapshot ${snapshotId}:`, error);
      }
    }
    syncState.currentSnapshotId = newHead.snapshotId;
    syncState.lastPublishedSnapshotId = newHead.snapshotId;
    syncState.lastPublishedRevision = newHead.revision;
    syncState.lastPublishedContentFingerprint = snapshotFingerprint(newHead);
    syncState.lastPublishedAt = new Date().toISOString();
    syncState.knownHeadSnapshotIds = [newHead.snapshotId];
    syncState.processedSnapshotIds = createdSnapshots.map(snapshot => snapshot.snapshotId);
    syncState.mergeParentSnapshotIds = [];
    syncRetentionMessage = '';
    await saveSyncState(syncState);
    return true;
  } catch (error) {
    if (!manifestPublished) {
      for (const snapshot of createdSnapshots) {
        try { await coordinator.deleteSnapshot(snapshot.snapshotId); } catch { /* best-effort cleanup */ }
      }
    }
    console.warn('Could not compact sync history:', error);
    return false;
  }
}

async function publishPendingSnapshotsUnsafe(): Promise<number> {
  const coordinator = syncCoordinatorFor();
  if (!capabilities.supabaseSync || !syncReady || syncState.status !== 'connected' || !hasCloudBinding() || !syncState.notebookId || syncState.conflicts.length || !coordinator) return 0;
  const checkedAt = startSyncCheck();
  await coordinator.connect();
  let manifestResource = await coordinator.readManifestResource();
  let manifest = manifestResource?.manifest ?? null;
  if (!manifest || !manifestResource) throw new Error('The connected cloud notebook is unavailable.');
  if (manifest.notebookId !== syncState.notebookId) throw new Error('The connected cloud notebook belongs to a different notebook.');
  const initialSnapshots = await coordinator.readSnapshotIndex(new Set(manifest.prunedSnapshotIds), syncState.notebookId);
  assertCompleteRemoteHistory(manifest, initialSnapshots);
  let published = 0;
  for (const snapshot of [...syncState.pendingSnapshots]) {
    if (snapshot.notebookId !== syncState.notebookId) throw new Error('A pending snapshot belongs to a different notebook.');
    manifestResource = await coordinator.publishSnapshot(snapshot);
    manifest = manifestResource.manifest;
    syncState.pendingSnapshots = syncState.pendingSnapshots.filter(item => item.snapshotId !== snapshot.snapshotId);
    syncState.knownHeadSnapshotIds = [...manifest.headSnapshotIds];
    syncState.lastPublishedSnapshotId = snapshot.snapshotId;
    syncState.lastPublishedRevision = snapshot.revision;
    syncState.lastPublishedContentFingerprint = snapshotFingerprint(snapshot);
    syncState.lastPublishedAt = new Date().toISOString();
    syncState.currentSnapshotId = snapshot.snapshotId;
    syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, snapshot.snapshotId])];
    syncState.mergeParentSnapshotIds = [];
    finishSyncCheck(checkedAt);
    await saveSyncState(syncState);
    published += 1;
  }
  if (published === 0) {
    finishSyncCheck(checkedAt);
    await saveSyncState(syncState);
  }
  await compactSyncHistory(coordinator);
  return published;
}

function snapshotAncestry(snapshotId: string, snapshots: Map<string, SyncSnapshot>): string[] {
  const result: string[] = [];
  const visited = new Set<string>();
  const pending = [snapshotId];
  while (pending.length) {
    const currentId = pending.pop()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);
    const snapshot = snapshots.get(currentId);
    if (!snapshot) continue;
    result.push(currentId);
    pending.push(...snapshot.parentSnapshotIds);
  }
  return result;
}

function assertCompleteRemoteHistory(manifest: SyncManifest, snapshots: Map<string, SyncSnapshot>) {
  if (!manifest.headSnapshotIds.length) throw new Error('The connected cloud notebook has no complete snapshot head.');
  for (const headId of manifest.headSnapshotIds) {
    const head = snapshots.get(headId);
    if (!head || !hasCompleteSnapshotAncestry(head, snapshots)) {
      throw new Error('The connected cloud notebook has incomplete or unavailable history.');
    }
  }
}

function taskEditorIsOpen(): boolean {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(dialog => dialog !== syncDialogElement);
}

function acceptedSnapshotId(): string | null {
  return syncState.currentSnapshotId ?? syncState.lastPublishedSnapshotId;
}

async function scanSharedUpdate(includeIgnored = false): Promise<AvailableUpdate | null> {
  const coordinator = syncCoordinatorFor();
  if (!capabilities.supabaseSync || !syncReady || syncState.status !== 'connected' || !hasCloudBinding() || !syncState.notebookId || !coordinator) return null;
  const manifest = await coordinator.readManifest();
  if (!manifest || manifest.notebookId !== syncState.notebookId) throw new Error('The connected cloud notebook has no matching manifest.');
  const snapshots = await coordinator.readSnapshotIndex(new Set(manifest.prunedSnapshotIds));
  assertCompleteRemoteHistory(manifest, snapshots);
  updateRetentionStatus(snapshots);
  const leaves = snapshotLeaves(snapshots);
  syncState.knownHeadSnapshotIds = [...new Set([...syncState.knownHeadSnapshotIds, ...manifest.headSnapshotIds, ...leaves.map(snapshot => snapshot.snapshotId)])];
  const currentId = acceptedSnapshotId();
  const candidates = leaves.filter(snapshot => {
    if (snapshot.snapshotId === currentId || syncState.processedSnapshotIds.includes(snapshot.snapshotId) || (!includeIgnored && ignoredUpdateIds.has(snapshot.snapshotId))) return false;
    if (currentId && snapshots.has(currentId) && isSnapshotAncestor(snapshot.snapshotId, currentId, snapshots)) return false;
    return true;
  });
  if (!candidates.length) return null;
  candidates.sort((first, second) => first.createdAt.localeCompare(second.createdAt));
  return { snapshot: candidates[candidates.length - 1], branchCount: candidates.length };
}

function updateRetentionStatus(snapshots: Map<string, SyncSnapshot>) {
  if (snapshots.size <= SYNC_SNAPSHOT_RETENTION_LIMIT) {
    syncRetentionMessage = '';
    return;
  }
  const leaves = snapshotLeaves(snapshots);
  if (syncState.conflicts.length) {
    syncRetentionMessage = `History retention is waiting for ${syncState.conflicts.length} unresolved conflict${syncState.conflicts.length === 1 ? '' : 's'}.`;
  } else if (syncState.pendingSnapshots.length) {
    syncRetentionMessage = 'History retention is waiting for pending publication.';
  } else if (leaves.length !== 1) {
    syncRetentionMessage = 'History retention is waiting for shared branches to be resolved.';
  } else {
    syncRetentionMessage = 'History will compact to a checkpoint after the next successful close.';
  }
}

async function checkForSharedUpdateUnsafe(allowFetching = false) {
  if (!syncReady || syncState.status !== 'connected' || sessionPhase === 'closing' || (sessionPhase === 'fetching' && !allowFetching)) return null;
  const checkedAt = startSyncCheck();
  try {
    const update = await withSyncTimeout(scanSharedUpdate());
    finishSyncCheck(checkedAt);
    await saveSyncState(syncState);
    if (update) {
      availableUpdate = update;
      setStatusMessage('');
      render();
    }
    return update;
  } catch (error) {
    syncState.lastCheckedAt = checkedAt;
    syncState.lastError = errorText(error);
    sessionPhase = 'offline';
    try { await saveSyncState(syncState); } catch { /* preserve the local backlog if metadata cannot be written */ }
    setStatusMessage(`Could not check for shared updates: ${syncState.lastError}`);
    render();
    return null;
  }
}

function checkForSharedUpdate(allowFetching = false): Promise<AvailableUpdate | null> {
  return enqueueSyncMutation(() => checkForSharedUpdateUnsafe(allowFetching));
}

async function applyFetchedSnapshot(snapshot: SyncSnapshot): Promise<void> {
  const localDocument = makeStoredDocument(notebook, revision, viewMode, theme);
  await writeStoredDocument(localDocument);
  notebook = notebookFromSnapshot(snapshot);
  revision = Math.max(revision, snapshot.revision);
  syncState.currentSnapshotId = snapshot.snapshotId;
  syncState.lastPublishedSnapshotId = snapshot.snapshotId;
  syncState.lastPublishedRevision = snapshot.revision;
  syncState.lastPublishedAt = snapshot.createdAt;
  syncState.knownHeadSnapshotIds = [...new Set([...syncState.knownHeadSnapshotIds, snapshot.snapshotId])];
  syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, snapshot.snapshotId])];
  syncState.pendingSnapshots = [];
  syncState.mergeParentSnapshotIds = [];
  syncState.conflicts = [];
  syncState.lastPublishedContentFingerprint = snapshotFingerprint(snapshot);
  syncState.lastError = null;
  sessionContentDirty = false;
  availableUpdate = null;
  queueSave(false);
  await saveQueue;
  await saveSyncState(syncState);
}

async function runSessionFetchUnsafe() {
  if (!syncReady || syncState.status !== 'connected') {
    sessionPhase = 'ready';
    render();
    return;
  }
  sessionPhase = 'fetching';
  setSyncStatusMessage('Publishing pending local changes and checking Supabase for updates.');
  render();
  if (syncState.pendingSnapshots.length) {
    try {
      await withSyncTimeout(publishPendingSnapshotsUnsafe());
      if (!syncState.pendingSnapshots.length && syncState.lastPublishedContentFingerprint === notebookFingerprint(notebook)) {
        sessionContentDirty = false;
      }
    } catch (error) {
      syncState.lastError = errorText(error);
      sessionPhase = 'offline';
      try { await saveSyncState(syncState); } catch { /* local data remains available */ }
      setStatusMessage(`Could not publish pending local changes: ${syncState.lastError}`);
      render();
      return;
    }
  }
  const update = await checkForSharedUpdateUnsafe(true);
  if (!update) {
    sessionPhase = syncState.lastError ? 'offline' : 'ready';
    setStatusMessage(syncState.lastError ? 'Working offline. Shared updates will be checked again.' : '');
    render();
    return;
  }
  if (update.branchCount > 1 || sessionContentDirty || syncState.pendingSnapshots.length) {
    sessionPhase = 'ready';
    setStatusMessage('A shared update is available.');
    render();
    return;
  }
  try {
    await applyFetchedSnapshot(update.snapshot);
    sessionPhase = 'ready';
    setStatusMessage(`Fetched the shared backlog from ${formatSyncCheckTime(update.snapshot.createdAt) || 'another device'}.`);
    render();
  } catch (error) {
    sessionPhase = 'offline';
    syncState.lastError = errorText(error);
    try { await saveSyncState(syncState); } catch { /* local data remains available */ }
    setStatusMessage(`Could not fetch the shared backlog: ${syncState.lastError}`);
    render();
  }
}

function startSessionFetch(): Promise<void> {
  if (sessionFetchInFlight) return sessionFetchInFlight;
  const operation = enqueueSyncMutation(() => runSessionFetchUnsafe());
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    if (sessionFetchInFlight === tracked) sessionFetchInFlight = null;
  });
  sessionFetchInFlight = tracked;
  return tracked;
}

async function retrySessionFetch() {
  syncState.lastError = null;
  await startSessionFetch();
}

type CloudDifferenceAction = 'replace' | 'merge';

function askFetchConfirmation(): Promise<CloudDifferenceAction | null> {
  return new Promise(resolve => {
    const editor = openDialog('Cloud notebook found');
    editor.body.append(
      element('p', '', 'Fetching this shared version will replace the visible list with the validated shared snapshot.'),
      element('p', 'advisory', hasLocalBacklog()
        ? 'Your current local backlog will be backed up first. Continue only if you want to replace this device’s saved list.'
        : 'This device has no saved backlog yet. The shared snapshot will become the local list after you confirm.'),
    );
    editor.save.textContent = 'Fetch';
    const mergeButton = button('Merge', () => {
      finish('merge');
      editor.dialog.close();
    });
    editor.controls.insertBefore(mergeButton, editor.save);
    let settled = false;
    const finish = (choice: CloudDifferenceAction | null) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    editor.dialog.addEventListener('close', () => finish(null), { once: true });
    editor.form.addEventListener('submit', event => {
      event.preventDefault();
      finish('replace');
      editor.dialog.close();
    });
  });
}

async function applyEverythingMerge(snapshot: SyncSnapshot): Promise<void> {
  await writeStoredDocument(makeStoredDocument(notebook, revision, viewMode, theme));
  const merged = mergeEverything(notebook, notebookFromSnapshot(snapshot));
  if (notebookFingerprint(merged) === snapshotFingerprint(snapshot)) {
    await applyFetchedSnapshot(snapshot);
    setStatusMessage('Everything was already included in the cloud backlog; no merge snapshot was needed.');
    return;
  }
  notebook = merged;
  revision = Math.max(revision, snapshot.revision);
  const currentId = acceptedSnapshotId();
  syncState.pendingSnapshots = [];
  syncState.mergeParentSnapshotIds = [...new Set([currentId, snapshot.snapshotId].filter((id): id is string => Boolean(id)))];
  syncState.currentSnapshotId = null;
  syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, snapshot.snapshotId])];
  syncState.conflicts = [];
  syncState.lastError = null;
  availableUpdate = null;
  sessionContentDirty = true;
  await saveSyncState(syncState);
  queueSave(true);
  setSyncStatusMessage('Saving and publishing the combined local and cloud backlog.');
  render();
}

async function fetchAvailableUpdateUnsafe() {
  if (!availableUpdate || (sessionPhase !== 'ready' && sessionPhase !== 'offline')) return;
  const requestedId = availableUpdate.snapshot.snapshotId;
  sessionPhase = 'fetching';
  setSyncStatusMessage('Rechecking and fetching the selected cloud update.');
  render();
  const fresh = await checkForSharedUpdateUnsafe(true);
  if (!fresh || fresh.snapshot.snapshotId !== requestedId) {
    if (!fresh) availableUpdate = null;
    sessionPhase = syncState.lastError ? 'offline' : 'ready';
    setStatusMessage(syncState.lastError ? 'Could not recheck the cloud update. Retry when you are back online.' : fresh ? 'A newer cloud update is available.' : 'That cloud update is no longer available.');
    render();
    return;
  }
  if (fresh.branchCount > 1) {
    sessionPhase = 'ready';
    setStatusMessage('Multiple shared branches are available. Open Sync to resolve them explicitly.');
    render();
    return;
  }
  if (sessionContentDirty) {
    const action = await askFetchConfirmation();
    if (!action) {
      sessionPhase = 'ready';
      availableUpdate = fresh;
      setStatusMessage('Fetch canceled; local edits were kept.');
      render();
      return;
    }
    if (action === 'merge') {
      await applyEverythingMerge(fresh.snapshot);
      sessionPhase = 'ready';
      return;
    }
  }
  try {
    await applyFetchedSnapshot(fresh.snapshot);
    sessionPhase = 'ready';
    setStatusMessage('Shared update fetched.');
    render();
  } catch (error) {
    sessionPhase = 'offline';
    syncState.lastError = errorText(error);
    try { await saveSyncState(syncState); } catch { /* local data remains available */ }
    setStatusMessage(`Could not fetch the shared update: ${syncState.lastError}`);
    render();
  }
}

function fetchAvailableUpdate(): Promise<void> {
  return enqueueSyncMutation(() => fetchAvailableUpdateUnsafe());
}

async function mergeAvailableUpdateUnsafe() {
  if (!availableUpdate || (sessionPhase !== 'ready' && sessionPhase !== 'offline')) return;
  const requestedId = availableUpdate.snapshot.snapshotId;
  sessionPhase = 'fetching';
  render();
  const fresh = await checkForSharedUpdateUnsafe(true);
  if (!fresh || fresh.snapshot.snapshotId !== requestedId) {
    sessionPhase = syncState.lastError ? 'offline' : 'ready';
    setStatusMessage(fresh ? 'A newer cloud update is available.' : 'That cloud update is no longer available.');
    render();
    return;
  }
  await applyEverythingMerge(fresh.snapshot);
  sessionPhase = 'ready';
}

function mergeAvailableUpdate(): Promise<void> {
  return enqueueSyncMutation(() => mergeAvailableUpdateUnsafe());
}

async function reconcileSyncUnsafe(): Promise<{ applied: number; conflicts: number }> {
  const coordinator = syncCoordinatorFor();
  if (!capabilities.supabaseSync || !syncReady || syncState.status !== 'connected' || !hasCloudBinding() || !syncState.notebookId || !coordinator) return { applied: 0, conflicts: 0 };
  if (taskEditorIsOpen()) {
    syncDeferred = true;
    return { applied: 0, conflicts: syncState.conflicts.length };
  }
  if (syncState.conflicts.length) return { applied: 0, conflicts: syncState.conflicts.length };
  const manifest = await coordinator.readManifest();
  if (!manifest || manifest.notebookId !== syncState.notebookId) throw new Error('The connected cloud notebook has no matching manifest.');
  const snapshots = await coordinator.readSnapshotIndex(new Set(manifest.prunedSnapshotIds));
  assertCompleteRemoteHistory(manifest, snapshots);
  syncState.knownHeadSnapshotIds = [...new Set([...syncState.knownHeadSnapshotIds, ...manifest.headSnapshotIds, ...snapshotLeaves(snapshots).map(snapshot => snapshot.snapshotId)])];
  const currentId = syncState.currentSnapshotId ?? syncState.lastPublishedSnapshotId;
  const completeLeaves = snapshotLeaves(snapshots);
  if (!currentId || !snapshots.has(currentId)) {
    if (!syncState.pendingSnapshots.length) {
      const fallback = completeLeaves.at(-1);
      if (fallback) {
        notebook = notebookFromSnapshot(fallback);
        revision = Math.max(revision, fallback.revision);
        syncState.currentSnapshotId = fallback.snapshotId;
        syncState.lastPublishedContentFingerprint = snapshotFingerprint(fallback);
        syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(fallback.snapshotId, snapshots)])];
        syncState.lastError = null;
        await saveSyncState(syncState);
        queueSave(false);
        render();
        setStatusMessage('Recovered the latest validated shared snapshot.');
        return { applied: 1, conflicts: 0 };
      }
    }
    await saveSyncState(syncState);
    return { applied: 0, conflicts: 0 };
  }
  const leaves = completeLeaves.filter(snapshot => snapshot.snapshotId !== currentId);
  let workingNotebook = notebook;
  let workingId = currentId;
  let applied = 0;
  for (const candidate of leaves) {
    if (syncState.processedSnapshotIds.includes(candidate.snapshotId)) continue;
    if (isSnapshotAncestor(candidate.snapshotId, workingId, snapshots)) {
      syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(candidate.snapshotId, snapshots)])];
      continue;
    }
    if (isSnapshotAncestor(workingId, candidate.snapshotId, snapshots)) {
      if (syncState.pendingSnapshots.length) {
        workingNotebook = mergeEverything(workingNotebook, { categories: candidate.categories });
        syncState.pendingSnapshots = [];
        syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(candidate.snapshotId, snapshots)])];
        syncState.mergeParentSnapshotIds = [...new Set([...syncState.mergeParentSnapshotIds, workingId, candidate.snapshotId])];
        syncState.currentSnapshotId = null;
        applied += 1;
        break;
      }
      workingNotebook = { categories: candidate.categories.map(category => ({ ...category, tasks: category.tasks.map(task => ({ ...task, scheduledDates: [...task.scheduledDates] })) })) };
      workingId = candidate.snapshotId;
      syncState.currentSnapshotId = candidate.snapshotId;
      syncState.lastPublishedContentFingerprint = snapshotFingerprint(candidate);
      syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(candidate.snapshotId, snapshots)])];
      applied += 1;
      continue;
    }
    workingNotebook = mergeEverything(workingNotebook, { categories: candidate.categories });
    if (syncState.pendingSnapshots.length) syncState.pendingSnapshots = [];
    syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(candidate.snapshotId, snapshots)])];
    syncState.mergeParentSnapshotIds = [...new Set([...syncState.mergeParentSnapshotIds, workingId, candidate.snapshotId])];
    syncState.currentSnapshotId = null;
    applied += 1;
    break;
  }
  if (applied && !syncState.conflicts.length) {
    notebook = workingNotebook;
    revision = Math.max(revision, ...leaves.map(snapshot => snapshot.revision), revision);
    if (syncState.currentSnapshotId) {
      syncState.lastPublishedRevision = revision + 1;
      await saveSyncState(syncState);
      queueSave(false);
      render();
      setStatusMessage(`Applied ${applied} remote snapshot${applied === 1 ? '' : 's'}.`);
    } else {
      await saveSyncState(syncState);
      queueSave(true);
      render();
      setSyncStatusMessage('Saving and publishing the combined local and cloud backlog.');
    }
  } else {
    await saveSyncState(syncState);
  }
  return { applied, conflicts: syncState.conflicts.length };
}

function reconcileSync(): Promise<{ applied: number; conflicts: number }> {
  return enqueueSyncMutation(() => reconcileSyncUnsafe());
}

async function queueSyncSnapshot(document: StoredDocument): Promise<void> {
  if (!syncReady || !capabilities.supabaseSync || !syncState.notebookId || !hasCloudBinding() || syncState.status === 'disconnected' || syncState.conflicts.length) return;
  try {
    await enqueueSyncMutation(async () => {
      if (!syncState.notebookId || !hasCloudBinding() || syncState.status === 'disconnected') return;
      const contentFingerprint = notebookFingerprint(document);
      const latestPending = syncState.pendingSnapshots.at(-1);
      if (!syncState.mergeParentSnapshotIds.length) {
        if (latestPending && snapshotFingerprint(latestPending) === contentFingerprint) return;
        if (syncState.lastPublishedContentFingerprint === contentFingerprint) {
          syncState.pendingSnapshots = [];
          sessionContentDirty = false;
          syncState.lastError = null;
          await saveSyncState(syncState);
          return;
        }
      }
      const previousPending = syncState.pendingSnapshots.at(-1)?.snapshotId;
      const parents = syncState.mergeParentSnapshotIds.length
        ? syncState.mergeParentSnapshotIds
        : previousPending
          ? [previousPending]
          : syncState.currentSnapshotId
            ? [syncState.currentSnapshotId]
            : syncState.knownHeadSnapshotIds;
      const snapshot = makeSyncSnapshot(document, syncState, parents);
      syncState.pendingSnapshots.push(snapshot);
      syncState.lastError = null;
      await saveSyncState(syncState);
    });
  } catch (error) {
    syncState.lastError = errorText(error);
    try { await saveSyncState(syncState); } catch { /* keep the local notebook usable if sync metadata is unavailable */ }
    throw error;
  }
}

function hasLocalBacklog(): boolean {
  return notebook.categories.length > 0 || revision > 0;
}

async function askStartSyncConfirmation(): Promise<boolean> {
  return new Promise(resolve => {
    const editor = openDialog('Start cloud sync?');
    editor.body.append(
      element('p', '', 'No Backlogger notebook exists for this Google account yet.'),
      element('p', 'advisory', 'Start sync with this device to create the first cloud checkpoint from the current local notebook. Nothing is uploaded before you confirm.'),
    );
    editor.save.textContent = 'Start sync with this device';
    let settled = false;
    const finish = (choice: boolean) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    editor.dialog.addEventListener('close', () => finish(false), { once: true });
    editor.form.addEventListener('submit', event => {
      event.preventDefault();
      finish(true);
      editor.dialog.close();
    });
  });
}

async function bindSupabaseAccount(): Promise<void> {
  const location = currentSupabaseLocation();
  await enqueueSyncMutation(async () => {
    const checkedAt = startSyncCheck();
    const transport = new SupabaseSyncTransport(location);
    const coordinator = new SyncCoordinator(transport);
    const remoteResource = await withSyncTimeout(coordinator.readManifestResource());
    cloudInspection = { accountId: location.accountId, manifest: remoteResource?.manifest ?? null, error: null };

    if (!remoteResource) {
      if (!(await askStartSyncConfirmation())) return;
      const notebookId = syncState.notebookId ?? crypto.randomUUID();
      const nextState = { ...syncState, notebookId };
      const checkpoint = makeCheckpointSnapshot(makeStoredDocument(notebook, revision, viewMode, theme), nextState);
      const initialManifest = makeSyncManifest(notebookId, syncState.deviceId, [checkpoint.snapshotId]);
      const initialized = await coordinator.initializeNotebook(checkpoint, initialManifest);
      cloudInspection = { accountId: location.accountId, manifest: initialized.manifest, error: null };
      syncState = {
        ...syncState,
        notebookId,
        location,
        status: 'connected',
        pendingSnapshots: [],
        knownHeadSnapshotIds: [checkpoint.snapshotId],
        lastPublishedSnapshotId: checkpoint.snapshotId,
        lastPublishedRevision: checkpoint.revision,
        lastPublishedContentFingerprint: snapshotFingerprint(checkpoint),
        lastPublishedAt: checkpoint.createdAt,
        lastCheckedAt: checkedAt,
        lastSuccessfulCheckAt: checkedAt,
        currentSnapshotId: checkpoint.snapshotId,
        processedSnapshotIds: [checkpoint.snapshotId],
        mergeParentSnapshotIds: [],
        conflicts: [],
        lastError: null,
      };
      sessionContentDirty = false;
      availableUpdate = null;
      sessionPhase = 'ready';
      await saveSyncState(syncState);
      setStatusMessage('Cloud sync started with this device.');
      render();
      return;
    }

    const manifest = remoteResource.manifest;
    const remoteCoordinator = new SyncCoordinator(transport, manifest.notebookId);
    const snapshots = await remoteCoordinator.readSnapshotIndex(new Set(manifest.prunedSnapshotIds), manifest.notebookId);
    if (manifest.headSnapshotIds.some(snapshotId => !snapshots.has(snapshotId))) {
      throw new Error('The cloud notebook is incomplete; no local data was replaced.');
    }
    const leaves = snapshotLeaves(snapshots);
    if (leaves.length !== 1 || !hasCompleteSnapshotAncestry(leaves[0], snapshots)) {
      throw new Error('The cloud notebook has multiple or incomplete branches; resolve it before connecting this device.');
    }
    const action = await askFetchConfirmation();
    if (!action) return;

    const previousState = structuredClone(syncState);
    try {
      syncState = {
        ...syncState,
        location,
        status: 'connected',
        notebookId: manifest.notebookId,
        pendingSnapshots: [],
        knownHeadSnapshotIds: [...manifest.headSnapshotIds],
        lastPublishedSnapshotId: null,
        lastPublishedRevision: null,
        lastPublishedContentFingerprint: null,
        lastPublishedAt: null,
        currentSnapshotId: null,
        processedSnapshotIds: [],
        mergeParentSnapshotIds: [],
        conflicts: [],
        lastError: null,
      };
      if (action === 'replace') {
        await applyFetchedSnapshot(leaves[0]);
      } else {
        syncState.currentSnapshotId = leaves[0].snapshotId;
        syncState.lastPublishedSnapshotId = leaves[0].snapshotId;
        syncState.lastPublishedRevision = leaves[0].revision;
        syncState.lastPublishedContentFingerprint = snapshotFingerprint(leaves[0]);
        syncState.processedSnapshotIds = snapshotAncestry(leaves[0].snapshotId, snapshots);
        await applyEverythingMerge(leaves[0]);
      }
      finishSyncCheck(checkedAt);
      await saveSyncState(syncState);
      sessionContentDirty = action === 'merge';
      sessionPhase = 'ready';
      setStatusMessage(action === 'replace' ? 'Cloud notebook fetched safely.' : 'Merged everything; the combined backlog is queued for sync.');
      render();
    } catch (error) {
      syncState = previousState;
      try { await saveSyncState(syncState); } catch { /* retain the original operation error */ }
      throw error;
    }
  });
}

async function disconnectSyncUnsafe(): Promise<void> {
  syncState.status = 'disconnected';
  syncState.location = null;
  syncState.lastError = null;
  cloudInspection = null;
  availableUpdate = null;
  if (sessionPhase === 'fetching') sessionPhase = 'ready';
  await saveSyncState(syncState);
  render();
}

async function disconnectSync(): Promise<void> {
  await enqueueSyncMutation(() => disconnectSyncUnsafe());
}

async function inspectAuthenticatedAccount(): Promise<void> {
  if (!capabilities.supabaseSync || !syncReady || !storageReady || authState.status !== 'signed-in' || !authState.userId) return;
  if (cloudInspectionInFlight) return cloudInspectionInFlight;
  const accountId = authState.userId;
  const operation = enqueueSyncMutation(async () => {
    try {
      const location = currentSupabaseLocation();
      const transport = new SupabaseSyncTransport(location);
      const resource = await withSyncTimeout(new SyncCoordinator(transport).readManifestResource());
      cloudInspection = { accountId, manifest: resource?.manifest ?? null, error: null };
      const active = cloudLocation();
      if (active?.accountId === accountId && syncState.status !== 'disconnected') {
        if (!resource || !syncState.notebookId || resource.manifest.notebookId !== syncState.notebookId) {
          await disconnectSyncUnsafe();
          setStatusMessage('The saved cloud binding is no longer available; local tasks were kept.');
        } else if (sessionPhase !== 'fetching' && sessionPhase !== 'closing') {
          void startSessionFetch().then(() => reconcileSync()).catch(error => {
            syncState.lastError = errorText(error);
            sessionPhase = 'offline';
            void saveSyncState(syncState);
            render();
          });
        }
      }
    } catch (error) {
      const message = errorText(error);
      cloudInspection = { accountId, manifest: null, error: message };
      if (cloudLocation()?.accountId === accountId && hasCloudBinding()) {
        syncState.lastError = message;
        sessionPhase = 'offline';
        try { await saveSyncState(syncState); } catch { /* local notebook remains usable */ }
      }
    }
    syncDialogRefresh?.();
    render();
  });
  let tracked: Promise<void>;
  tracked = operation.finally(() => {
    if (cloudInspectionInFlight === tracked) {
      cloudInspectionInFlight = null;
      syncDialogRefresh?.();
      render();
    }
  });
  cloudInspectionInFlight = tracked;
  await tracked;
}

async function handleAuthStateChange(next: AuthState): Promise<void> {
  await enqueueSyncMutation(async () => {
    authState = next;
    if (next.status === 'signing-in') signInStartedAt ??= Date.now();
    else signInStartedAt = null;
    syncDialogRefresh?.();
    render();
    if (next.status === 'signed-out') {
      if (cloudLocation()) await disconnectSyncUnsafe();
      return;
    }
    if (next.status !== 'signed-in' || !next.userId) return;
    if (cloudLocation() && cloudLocation()?.accountId !== next.userId) await disconnectSyncUnsafe();
  });
  if (next.status === 'signed-in' && next.userId) await inspectAuthenticatedAccount();
}

async function toggleSyncPause(): Promise<void> {
  await enqueueSyncMutation(async () => {
    if (!hasCloudBinding() || syncState.status === 'disconnected') throw new Error('Log in to sync first.');
    syncState.status = syncState.status === 'paused' ? 'connected' : 'paused';
    syncState.lastError = null;
    await saveSyncState(syncState);
    if (syncState.status === 'connected') await checkForSharedUpdateUnsafe();
  });
}

async function syncNow(): Promise<number> {
  return enqueueSyncMutation(async () => {
    if (syncState.status === 'paused') throw new Error('Resume cloud sync before checking for updates.');
    if (!hasCloudBinding() || syncState.status === 'disconnected') throw new Error('Log in to sync first.');
    const update = await checkForSharedUpdateUnsafe();
    return update ? 1 : 0;
  });
}

function openSyncDialog() {
  const editor = openDialog('Sync');
  syncDialogElement = editor.dialog;
  editor.dialog.addEventListener('close', () => {
    if (syncDialogElement === editor.dialog) syncDialogElement = null;
    syncDialogRefresh = null;
  }, { once: true });
  const intro = element('p', '', 'Sync Backlogger across your Windows devices with one Google account.');
  const statusLine = element('p', 'import-summary');
  const accountLine = element('p', 'import-summary');
  const controls = element('div', 'sync-controls');
  const loginButton = button('Continue with Google', () => void login());
  const cancelLoginButton = button('Cancel sign-in', () => cancelPendingLogin());
  const startButton = button('Start sync', () => void connect());
  const syncNowButton = button('Check for updates', () => void runSyncNow());
  const pauseButton = button(syncState.status === 'paused' ? 'Resume' : 'Pause', () => void togglePause());
  const resolveButton = button('Merge', () => void mergeStoredConflicts());
  const logoutButton = button('Log out', () => void logout());
  controls.append(loginButton, cancelLoginButton, startButton, syncNowButton, pauseButton, resolveButton, logoutButton);
  editor.body.append(intro, statusLine, accountLine, controls);
  editor.save.textContent = 'Close';

  function refresh() {
    statusLine.textContent = `${syncStatusLabel()} · ${syncStatusDetail()}`;
    const signedIn = authState.status === 'signed-in' && Boolean(authState.userId);
    const connected = hasCloudBinding();
    loginButton.hidden = signedIn;
    loginButton.disabled = !capabilities.supabaseSync || !authState.configured || authState.status === 'signing-in' || !syncReady;
    cancelLoginButton.hidden = authState.status !== 'signing-in';
    startButton.hidden = !signedIn || connected;
    startButton.disabled = !syncReady || Boolean(cloudInspectionInFlight);
    syncNowButton.hidden = !connected;
    syncNowButton.disabled = !connected || syncState.status === 'paused';
    pauseButton.hidden = !connected;
    pauseButton.disabled = !connected;
    resolveButton.hidden = !connected;
    resolveButton.disabled = !syncState.conflicts.length;
    logoutButton.hidden = !signedIn;
    logoutButton.disabled = authState.status === 'signing-in';
    pauseButton.textContent = syncState.status === 'paused' ? 'Resume' : 'Pause';
    editor.save.disabled = false;
    if (!authState.configured) accountLine.textContent = 'Sync is not configured for this build.';
    else if (signedIn) {
      const email = authState.email ?? 'Google account';
      const inspection = cloudInspection?.accountId === authState.userId ? cloudInspection : null;
      accountLine.textContent = inspection?.error
        ? `Signed in as ${email}. ${inspection.error}`
        : inspection && !inspection.manifest
          ? `Signed in as ${email}. No cloud notebook exists yet.`
          : `Signed in as ${email}.`;
    } else if (authState.status === 'loading') accountLine.textContent = 'Checking your Google sign-in…';
    else if (authState.status === 'signing-in') accountLine.textContent = 'Complete Google sign-in in your browser.';
    else accountLine.textContent = authState.error ?? 'Not logged in.';
  }

  async function login() {
    editor.error.textContent = '';
    try {
      await startGoogleSignIn();
    } catch (error) {
      editor.error.textContent = errorText(error);
      refresh();
    }
  }

  function cancelPendingLogin() {
    cancelGoogleSignIn();
    setStatusMessage('Google sign-in canceled. You can try again.');
    refresh();
  }

  async function connect() {
    editor.error.textContent = '';
    try {
      await bindSupabaseAccount();
      refresh();
      if (hasCloudBinding()) editor.dialog.close();
      void attemptPendingSync();
    } catch (error) {
      editor.error.textContent = `Could not start cloud sync: ${errorText(error)}`;
      refresh();
    }
  }

  async function runSyncNow() {
    editor.error.textContent = '';
    try {
      const count = await syncNow();
      setStatusMessage(syncState.conflicts.length
        ? `${syncState.conflicts.length} sync conflict${syncState.conflicts.length === 1 ? '' : 's'} need attention.`
        : count ? 'Cloud update available.' : 'No cloud update found.');
      refresh();
    } catch (error) {
      editor.error.textContent = `Sync failed: ${errorText(error)}`;
      refresh();
    }
  }

  async function mergeStoredConflicts() {
    syncState.conflicts = [];
    syncState.lastError = null;
    sessionContentDirty = true;
    await saveSyncState(syncState);
    queueSave(true);
    setSyncStatusMessage('Saving and publishing the combined local and cloud backlog.');
    refresh();
  }

  async function togglePause() {
    editor.error.textContent = '';
    try {
      await toggleSyncPause();
      setStatusMessage(syncState.status === 'paused' ? 'Cloud sync paused; local saves continue.' : 'Cloud sync resumed.');
      refresh();
    } catch (error) {
      editor.error.textContent = `Could not change sync state: ${errorText(error)}`;
      refresh();
    }
  }

  async function logout() {
    editor.error.textContent = '';
    try {
      await signOutAuth();
      await disconnectSync();
      setStatusMessage('Logged out. Local tasks and recoverable sync state were kept.');
      refresh();
    } catch (error) {
      editor.error.textContent = `Could not disconnect: ${errorText(error)}`;
      refresh();
    }
  }

  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    editor.dialog.close();
  });
  syncDialogRefresh = refresh;
  refresh();
}

async function recoverBackup() {
  recoverButton.disabled = true;
  try {
    const backup = await readStoredBackup();
    if (!backup) {
      setStatusMessage('No valid local backup was found.');
      return;
    }
    const editor = openDialog('Recover backup?');
    editor.body.append(
      element('p', '', 'The current saved data could not be loaded.'),
      element('p', 'import-summary', `Recover ${backup.categories.length} categor${backup.categories.length === 1 ? 'y' : 'ies'} and ${taskCount(backup.categories)} task(s) from the last valid backup?`),
    );
    editor.save.textContent = 'Recover and save';
    editor.form.addEventListener('submit', event => {
      event.preventDefault();
      commit(() => {
        notebook = { categories: backup.categories };
        viewMode = backup.preferences.viewMode;
        revision = backup.revision;
        storageBlocked = false;
        recoverButton.hidden = true;
      }, 'Backup recovered.', true);
      editor.dialog.close();
    });
  } catch (error) {
    setStatusMessage(`Backup recovery failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    recoverButton.disabled = false;
  }
}

function queueSave(publishSync = false) {
  if (!storageReady) return;
  hasUnsavedChanges = true;
  retrySaveButton.hidden = true;
  if (storageBlocked) {
    setStorageNotice('Saved data needs attention', 'Your edits remain open but are not being overwritten.');
    setStatusMessage('Saving is paused because the existing local data could not be validated.');
    return;
  }
  const documentToSave = makeStoredDocument(notebook, ++revision, viewMode, theme);
  const sequence = ++saveSequence;
  setStorageNotice('Saving locally…', capabilities.nativeLocalStorage ? 'Writing a versioned file in the app-data folder.' : 'Writing to browser local storage for this preview.');
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => writeStoredDocument(documentToSave))
    .then(async () => {
      if (publishSync) await queueSyncSnapshot(documentToSave);
      if (sequence === saveSequence) {
        hasUnsavedChanges = false;
        retrySaveButton.hidden = true;
        setStorageNotice('Saved locally', capabilities.nativeLocalStorage ? 'Your backlog is stored on this device.' : 'Preview data is stored in this browser.');
      }
    })
    .catch(error => {
      if (sequence === saveSequence) {
        retrySaveButton.hidden = false;
        setStorageNotice('Save failed', 'Your changes remain open. Retry the local save when ready.');
        setStatusMessage(`Could not save local data: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function clearUndo() {
  clearTimeout(undoTimer);
  undoState = null;
  undoButton.hidden = true;
}

function commit(change: () => void, message: string, canUndo = false) {
  if (storageBlocked || closeInProgress || (sessionPhase !== 'ready' && sessionPhase !== 'offline')) return;
  clearUndo();
  if (canUndo) undoState = structuredClone(notebook);
  change();
  sessionContentDirty = true;
  render();
  queueSave(false);
  setStatusMessage(canUndo ? message : '');
  undoButton.hidden = !canUndo;
  if (canUndo) {
    undoTimer = setTimeout(() => {
      const focused = document.activeElement === undoButton;
      clearUndo();
      setStatusMessage('');
      if (focused) focusWithoutScrolling(addCategory);
    }, 15_000);
    focusWithoutScrolling(undoButton);
  }
}

function openDialog(title: string) {
  const previousFocus = document.activeElement as HTMLElement | null;
  const menuTrigger = previousFocus?.closest('details')?.querySelector('summary');
  const scrollPosition = readScrollPosition();
  const dialog = element('dialog', 'editor');
  const heading = element('h2', '', title);
  heading.id = 'dialog-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  const form = element('form');
  const body = element('div', 'editor-body');
  const error = element('p', 'form-error');
  error.setAttribute('role', 'alert');
  const controls = element('div', 'editor-actions');
  const cancel = button('Cancel', () => dialog.close());
  const save = element('button', 'primary-button', 'Save');
  save.type = 'submit';
  controls.append(cancel, save);
  form.append(heading, body, error, controls);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (menuTrigger?.isConnected) focusWithoutScrolling(menuTrigger);
    else if (previousFocus?.isConnected) focusWithoutScrolling(previousFocus);
    else if (undoState) focusWithoutScrolling(undoButton);
    else focusWithoutScrolling(addCategory);
    restoreScrollPosition(scrollPosition);
    if (syncDeferred) {
      syncDeferred = false;
      void attemptPendingSync();
    }
  }, { once: true });
  dialog.showModal();
  return { dialog, form, body, error, controls, save };
}

function textField(labelText: string, value: string) {
  const label = element('label', 'field', labelText);
  const input = element('input');
  input.type = 'text';
  input.value = value;
  input.required = true;
  input.maxLength = 500;
  label.append(input);
  return { label, input };
}

function editCategory(category?: Category) {
  const editor = openDialog(category ? 'Rename category' : 'Add category');
  const field = textField('Category name', category?.name ?? '');
  editor.body.append(field.label);
  field.input.focus();
  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    const name = field.input.value.trim();
    if (!name) { editor.error.textContent = 'Enter a category name.'; return; }
    commit(() => {
      if (category) category.name = name;
      else notebook.categories.push({ id: crypto.randomUUID(), name, tasks: [] });
    }, category ? 'Category renamed.' : 'Category added.');
    editor.dialog.close();
  });
}

function removeCategory(category: Category) {
  const remove = () => commit(() => {
    notebook.categories = notebook.categories.filter(item => item.id !== category.id);
  }, `Deleted ${category.name}.`, true);
  if (category.tasks.length === 0) { remove(); return; }
  const editor = openDialog('Delete category?');
  editor.body.append(element('p', '', `Delete ${category.name} and its ${category.tasks.length} task(s)?`));
  editor.save.textContent = 'Delete category and tasks';
  editor.save.className = 'danger-button';
  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    remove();
    editor.dialog.close();
  });
}

function moveCategory(category: Category, direction: -1 | 1) {
  const index = notebook.categories.indexOf(category);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= notebook.categories.length) return;
  commit(() => {
    [notebook.categories[index], notebook.categories[next]] = [notebook.categories[next], notebook.categories[index]];
  }, `Moved ${category.name} ${direction < 0 ? 'up' : 'down'}.`);
}

function moveTask(category: Category, task: Task, direction: -1 | 1) {
  const index = category.tasks.indexOf(task);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= category.tasks.length) return;
  commit(() => {
    [category.tasks[index], category.tasks[next]] = [category.tasks[next], category.tasks[index]];
  }, `Moved ${task.title} ${direction < 0 ? 'up' : 'down'}.`);
}

function isScheduledToday(task: Task, today = localToday()): boolean {
  return isScheduledOn(task, today);
}

function isScheduledOn(task: Task, date: string): boolean {
  return task.scheduledDates.includes(date);
}

function markTaskDone(task: Task, today = localToday()) {
  if (!isScheduledToday(task, today)) return;
  commit(() => {
    task.scheduledDates = task.scheduledDates.filter(date => date !== today);
  }, `Marked ${task.title} done.`);
}

function editTask(category: Category, task?: Task) {
  const editor = openDialog(task ? 'Edit task' : `Add task to ${category.name}`);
  const title = textField('Task title', task?.title ?? '');
  const categoryLabel = element('label', 'field', 'Category');
  const categorySelect = element('select');
  notebook.categories.forEach(item => {
    const option = element('option');
    option.value = item.id;
    option.textContent = item.name;
    option.selected = item.id === category.id;
    categorySelect.append(option);
  });
  categoryLabel.append(categorySelect);
  let selected = [...(task?.scheduledDates ?? [])];
  let week = weekStart(localToday());
  const calendar = element('fieldset', 'calendar');
  calendar.append(element('legend', '', 'Work dates'));
  const weekNav = element('div', 'week-nav');
  const range = element('span', 'week-range');
  range.setAttribute('aria-live', 'polite');
  const days = element('div', 'week-days');
  const selectedDates = element('div', 'selected-dates');
  const deadlineLabel = element('label', 'field', 'Deadline (optional)');
  const deadline = element('input');
  deadline.type = 'date';
  deadline.min = '0001-01-01';
  deadline.max = '9999-12-31';
  deadline.value = task?.deadlineDate ?? '';
  deadlineLabel.append(deadline);
  const advisory = element('p', 'advisory');
  advisory.setAttribute('aria-live', 'polite');
  const clearDeadline = button('Clear deadline', () => { deadline.value = ''; updateAdvisory(); });
  const updateAdvisory = () => {
    clearDeadline.hidden = !deadline.value;
    advisory.textContent = deadline.value && selected.some(date => date > deadline.value)
      ? 'Some work dates are after the deadline. You can still save.' : '';
  };
  function drawCalendar() {
    range.textContent = `${dateLabel(week)} – ${dateLabel(shiftDate(week, 6))}`;
    days.replaceChildren();
    ['M', 'T', 'W', 'H', 'F', 'A', 'S'].forEach((code, index) => {
      const date = shiftDate(week, index);
      const day = button(`${code} ${parseDate(date).getUTCDate()}`, () => {
        selected = selected.includes(date) ? selected.filter(value => value !== date) : normalizeDates([...selected, date]);
        drawCalendar();
        (days.children[index] as HTMLButtonElement).focus();
      }, 'day-button');
      day.setAttribute('aria-label', dateLabel(date));
      day.setAttribute('aria-pressed', String(selected.includes(date)));
      days.append(day);
    });
    selectedDates.replaceChildren();
    selected.forEach(date => {
      const remove = button(`${dateLabel(date)} ×`, () => {
        selected = selected.filter(value => value !== date);
        drawCalendar();
        (days.firstElementChild as HTMLButtonElement).focus();
      }, 'date-chip');
      remove.setAttribute('aria-label', `Remove ${dateLabel(date)}`);
      selectedDates.append(remove);
    });
    updateAdvisory();
  }
  weekNav.append(button('‹', () => { week = shiftDate(week, -7); drawCalendar(); }), range,
    button('›', () => { week = shiftDate(week, 7); drawCalendar(); }));
  weekNav.firstElementChild!.setAttribute('aria-label', 'Previous week');
  weekNav.lastElementChild!.setAttribute('aria-label', 'Next week');
  calendar.append(weekNav, days, selectedDates);
  deadline.addEventListener('input', updateAdvisory);
  editor.body.append(title.label);
  if (task && notebook.categories.length > 1) editor.body.append(categoryLabel);
  editor.body.append(calendar, deadlineLabel,
    clearDeadline, advisory);
  drawCalendar();
  title.input.focus();
  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    const name = title.input.value.trim();
    if (!name) { editor.error.textContent = 'Enter a task title.'; return; }
    try {
      const dates = normalizeDates(selected);
      if (deadline.value) parseDate(deadline.value);
      const destination = notebook.categories.find(item => item.id === categorySelect.value) ?? category;
      commit(() => {
        if (task) {
          Object.assign(task, { title: name, scheduledDates: dates, deadlineDate: deadline.value || null });
          if (destination !== category) {
            category.tasks = category.tasks.filter(item => item.id !== task.id);
            destination.tasks.push(task);
          }
        }
        else category.tasks.push({ id: crypto.randomUUID(), title: name, scheduledDates: dates, deadlineDate: deadline.value || null });
      }, task && destination !== category ? `Task moved to ${destination.name}.` : task ? 'Task updated.' : 'Task added.');
      editor.dialog.close();
    } catch (error) {
      editor.error.textContent = error instanceof Error ? error.message : 'Unable to save this task.';
    }
  });
}

function render() {
  if (dragState) clearDragSession();
  const scrollPosition = readScrollPosition();
  list.replaceChildren();
  const today = localToday();
  const tomorrow = shiftDate(today, 1);
  const editingReady = storageReady && !storageBlocked && !closeInProgress && (sessionPhase === 'ready' || sessionPhase === 'offline');
  allView.setAttribute('aria-pressed', String(viewMode === 'all'));
  todayView.setAttribute('aria-pressed', String(viewMode === 'today'));
  tomorrowView.setAttribute('aria-pressed', String(viewMode === 'tomorrow'));
  todayView.textContent = 'Today';
  todayView.title = dateLabel(today);
  tomorrowView.textContent = 'Tomorrow';
  tomorrowView.title = dateLabel(tomorrow);
  addCategory.disabled = !editingReady;
  themeButton.disabled = !editingReady;
  allView.disabled = todayView.disabled = tomorrowView.disabled = !editingReady;
  importButton.disabled = exportButton.disabled = !editingReady || !capabilities.documentImportExport;
  if (!capabilities.documentImportExport) {
    importButton.title = 'Import and export will be available in a later Android milestone.';
    exportButton.title = 'Import and export will be available in a later Android milestone.';
  }
  syncButton.textContent = hasCloudBinding() ? 'Sync' : 'Log in to Sync';
  syncButton.disabled = !storageReady || closeInProgress || !capabilities.cloudSync || !syncReady;
  undoButton.disabled = !editingReady;
  renderStatusBar();
  if (notebook.categories.length === 0) {
    const empty = element('section', 'empty-notebook');
    empty.append(element('p', '', storageReady ? 'No categories yet.' : 'Loading…'));
    list.append(empty);
  }
  let visibleCategoryCount = 0;
  notebook.categories.forEach(category => {
    const filteredDate = viewMode === 'today' ? today : viewMode === 'tomorrow' ? tomorrow : null;
    const visibleTasks = filteredDate ? category.tasks.filter(task => isScheduledOn(task, filteredDate)) : category.tasks;
    if (filteredDate && visibleTasks.length === 0) return;
    visibleCategoryCount += 1;
    const section = element('section', 'category');
    section.dataset.categoryId = category.id;
    const heading = element('h2', 'category-heading', category.name);
    heading.id = `category-${category.id}`;
    section.setAttribute('aria-labelledby', heading.id);
    const top = element('div', 'category-top');
    const categoryLabel = element('div', 'category-label');
    categoryLabel.append(dragHandle(`Reorder ${category.name}`, section, { kind: 'category', categoryId: category.id }, editingReady));
    const controls = element('div', 'row-actions');
    const categoryIndex = notebook.categories.indexOf(category);
    const upCategory = button('Move up', () => moveCategory(category, -1));
    upCategory.disabled = !editingReady || categoryIndex === 0;
    upCategory.setAttribute('aria-label', `Move ${category.name} up`);
    const downCategory = button('Move down', () => moveCategory(category, 1));
    downCategory.disabled = !editingReady || categoryIndex === notebook.categories.length - 1;
    downCategory.setAttribute('aria-label', `Move ${category.name} down`);
    const add = iconButton('plus', `Add task to ${category.name}`, () => editTask(category));
    add.disabled = !editingReady;
    const rename = button('Rename', () => editCategory(category));
    rename.disabled = !editingReady;
    rename.setAttribute('aria-label', `Rename ${category.name}`);
    const remove = button('Delete', () => removeCategory(category));
    remove.disabled = !editingReady;
    remove.setAttribute('aria-label', `Delete category ${category.name}`);
    remove.classList.add('destructive');
    controls.append(add, actionMenu(`Options for ${category.name}`, [rename, upCategory, downCategory, remove]));
    categoryLabel.append(heading);
    top.append(categoryLabel, controls);
    section.append(top);
    const tasks = element('ul', 'tasks');
    visibleTasks.forEach(task => {
      const taskIndex = category.tasks.indexOf(task);
      const row = element('li', 'task');
      row.dataset.categoryId = category.id;
      row.dataset.taskId = task.id;
      const scheduledToday = isScheduledToday(task, today);
      const edit = button(task.title, () => editTask(category, task), `task-title task-edit${scheduledToday ? ' scheduled-today' : ''}`);
      edit.disabled = !editingReady;
      edit.setAttribute('aria-label', `Edit task ${task.title}${scheduledToday ? '; Scheduled today' : ''}`);
      const content = element('div', 'task-content');
      content.append(edit);
      if (task.scheduledDates.length) {
        const dates = element('span', 'annotation work', ` [${compactDateList(task.scheduledDates, today)}]`);
        dates.title = task.scheduledDates.map(dateLabel).join(', ');
        content.append(dates);
      }
      if (task.deadlineDate) {
        const overdue = task.deadlineDate < today;
        const due = element('span', `annotation due${overdue ? ' overdue' : ''}`, ` (${compactDate(task.deadlineDate, today)})${overdue ? ' !' : ''}`);
        due.title = `${overdue ? 'Overdue' : task.deadlineDate === today ? 'Due today' : 'Due'}: ${dateLabel(task.deadlineDate)}`;
        due.setAttribute('aria-label', due.title);
        content.append(due);
      }
      const complete = scheduledToday ? iconButton('check', `Mark ${task.title} done`, () => markTaskDone(task, today)) : null;
      const handle = dragHandle(`Reorder ${task.title}`, row, { kind: 'task', categoryId: category.id, taskId: task.id }, editingReady);
      row.append(handle);
      if (complete) {
        complete.classList.add('task-complete');
        complete.disabled = !editingReady;
        row.append(content, complete);
      } else {
        row.append(content);
      }
      const remove = button('Delete', () => commit(() => {
        category.tasks = category.tasks.filter(item => item.id !== task.id);
      }, `Deleted ${task.title}.`, true), 'quiet-button task-delete');
      remove.disabled = !editingReady;
      remove.setAttribute('aria-label', `Delete task ${task.title}`);
      const upTask = button('Move up', () => moveTask(category, task, -1));
      upTask.disabled = !editingReady || taskIndex === 0;
      upTask.setAttribute('aria-label', `Move task ${task.title} up`);
      const downTask = button('Move down', () => moveTask(category, task, 1));
      downTask.disabled = !editingReady || taskIndex === category.tasks.length - 1;
      downTask.setAttribute('aria-label', `Move task ${task.title} down`);
      remove.className = 'quiet-button destructive';
      const taskEditAction = button('Edit', () => editTask(category, task));
      taskEditAction.disabled = !editingReady;
      row.append(actionMenu(`Options for ${task.title}`, [taskEditAction, upTask, downTask, remove]));
      tasks.append(row);
    });
    section.append(tasks);
    list.append(section);
  });
  if (viewMode !== 'all' && visibleCategoryCount === 0 && notebook.categories.length > 0) {
    const empty = element('section', 'empty-notebook');
    empty.append(element('p', '', `Nothing scheduled ${viewMode}.`));
    list.append(empty);
  }
  restoreScrollPosition(scrollPosition);
}

function askCloseAfterSaveTimeout(): Promise<boolean> {
  return new Promise(resolve => {
    const editor = openDialog('Save is taking too long');
    const cancel = editor.form.querySelector<HTMLButtonElement>('button:not([type="submit"])');
    if (cancel) cancel.textContent = 'Keep app open';
    editor.save.textContent = 'Close with last saved copy';
    editor.body.append(
      element('p', '', 'The local save did not finish in time.'),
      element('p', 'advisory', 'Keep the app open to retry. Closing now preserves the last completed local copy; any unsaved edit may need to be entered again.'),
    );
    let settled = false;
    const finish = (choice: boolean) => {
      if (settled) return;
      settled = true;
      resolve(choice);
    };
    editor.dialog.addEventListener('close', () => finish(false), { once: true });
    editor.form.addEventListener('submit', event => {
      event.preventDefault();
      finish(true);
      editor.dialog.close();
    });
  });
}

async function writeCloseSnapshot(): Promise<void> {
  const coordinator = syncCoordinatorFor();
  if (!hasCloudBinding() || !syncState.notebookId || syncState.conflicts.length || !coordinator) return;
  const pendingBaseParents = syncState.pendingSnapshots[0]?.parentSnapshotIds ?? [];
  const parents = syncState.mergeParentSnapshotIds.length
    ? syncState.mergeParentSnapshotIds
    : syncState.currentSnapshotId
      ? [syncState.currentSnapshotId]
      : pendingBaseParents.length
        ? pendingBaseParents
        : syncState.knownHeadSnapshotIds;
  const document = makeStoredDocument(notebook, revision, viewMode, theme);
  const contentFingerprint = notebookFingerprint(notebook);
  if (!syncState.mergeParentSnapshotIds.length && syncState.lastPublishedContentFingerprint === contentFingerprint) {
    syncState.pendingSnapshots = [];
    syncState.lastError = null;
    sessionContentDirty = false;
    await saveSyncState(syncState);
    return;
  }
  const existingPending = syncState.pendingSnapshots.at(-1);
  const snapshot = existingPending
    && existingPending.revision === document.revision
    && snapshotFingerprint(existingPending) === contentFingerprint
    ? existingPending
    : makeSyncSnapshot(document, syncState, parents);

  // Save the final state as pending before touching Supabase. Full
  // publication writes both the immutable snapshot and the manifest. Startup
  // and periodic checks retry this same snapshot if either operation fails.
  syncState.pendingSnapshots = [snapshot];
  syncState.lastError = null;
  await saveSyncState(syncState);
  await enqueueSyncMutation(() => publishPendingSnapshotsUnsafe());
}

async function closeSession(): Promise<boolean> {
  try {
    await withTimeout(saveQueue, CLOSE_OPERATION_TIMEOUT_MS, 'The local save did not finish before closing.');
  } catch {
    retrySaveButton.hidden = false;
    setStatusMessage('The local save is taking too long.');
    const closeWithLastSavedCopy = await askCloseAfterSaveTimeout();
    if (!closeWithLastSavedCopy) {
      closeInProgress = false;
      sessionPhase = 'ready';
      render();
      return false;
    }
    return true;
  }
  if (hasUnsavedChanges || storageBlocked) {
    setStatusMessage('Local changes are not saved. Retry the local save before closing.');
    sessionPhase = 'ready';
    render();
    return false;
  }
  if (!hasCloudBinding() || syncState.status !== 'connected' || !syncState.notebookId) return true;

  const localNeedsPublish = sessionContentDirty || syncState.pendingSnapshots.length > 0;
  if (localNeedsPublish) {
    try {
      await withTimeout(
        writeCloseSnapshot(),
        CLOSE_SNAPSHOT_TIMEOUT_MS,
        'The sync publication did not finish before closing.',
      );
      sessionContentDirty = false;
      return true;
    } catch (error) {
      syncState.lastError = errorText(error);
      try { await saveSyncState(syncState); } catch { /* pending publication is already persisted when possible */ }
      return true;
    }
  }
  return true;
}

async function installNativeCloseHandler() {
  if (!capabilities.desktopClose) return;
  await getCurrentWindow().onCloseRequested(async event => {
    if (closeInProgress) {
      event.preventDefault();
      return;
    }
    closeInProgress = true;
    sessionPhase = 'closing';
    setStatusMessage('Closing…');
    render();
    try {
      if (await closeSession()) return;
    } catch (error) {
      sessionPhase = 'offline';
      setStatusMessage(`Could not finish closing safely: ${errorText(error)}`);
    }
    event.preventDefault();
    closeInProgress = false;
    if (sessionPhase === 'closing') sessionPhase = 'ready';
    render();
  });
}

window.addEventListener('beforeunload', event => {
  if (hasUnsavedChanges) { event.preventDefault(); event.returnValue = ''; }
});

let lastRenderedToday = localToday();
const refreshDateState = () => {
  const current = localToday();
  if (current !== lastRenderedToday) {
    lastRenderedToday = current;
    render();
  }
};
window.addEventListener('focus', () => {
  refreshDateState();
  void checkForSharedUpdate();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshDateState();
    void checkForSharedUpdate();
  }
});
setInterval(refreshDateState, 30_000);

async function attemptPendingSync() {
  if (taskEditorIsOpen()) {
    syncDeferred = true;
    return;
  }
  if (syncState.pendingSnapshots.length) {
    await startSessionFetch();
    return;
  }
  await checkForSharedUpdate();
}

setInterval(() => void attemptPendingSync(), 15_000);

async function loadInitialData() {
  try {
    const stored = await readStoredDocument();
    if (stored) {
      notebook = { categories: stored.categories };
      viewMode = stored.preferences.viewMode;
      theme = stored.preferences.theme;
      applyTheme();
      revision = stored.revision;
    }
    try {
      syncState = await loadSyncState();
      syncReady = true;
      syncLoadError = null;
    } catch (error) {
      syncReady = false;
      syncLoadError = errorText(error);
    }
    storageReady = true;
    const localContentFingerprint = notebookFingerprint(notebook);
    const fingerprintChanged = syncState.lastPublishedContentFingerprint
      ? syncState.lastPublishedContentFingerprint !== localContentFingerprint
      : syncState.lastPublishedRevision !== null && revision > syncState.lastPublishedRevision;
    sessionContentDirty = syncState.pendingSnapshots.length > 0 || (syncState.status === 'connected' && fingerprintChanged);
    recoverButton.hidden = true;
    setStorageNotice(stored ? 'Saved locally' : 'Local data ready', capabilities.nativeLocalStorage ? 'Your backlog is stored on this device.' : 'Preview data will be stored in this browser.');
    sessionPhase = syncLoadError ? 'offline' : 'ready';
    render();
    if (syncReady && syncState.status === 'connected' && authState.status === 'signed-in') void inspectAuthenticatedAccount();
    else setStatusMessage(syncLoadError ? 'Working offline. Sync settings could not be loaded.' : '');
  } catch (error) {
    storageReady = true;
    syncReady = false;
    sessionPhase = 'offline';
    storageBlocked = true;
    recoverButton.hidden = false;
    setStorageNotice('Saved data needs attention', 'The existing local data was preserved and was not replaced.');
    setStatusMessage(`Could not load local data: ${error instanceof Error ? error.message : String(error)}`);
    render();
  }
}
applyTheme();
render();
setStorageNotice('Loading local data…', 'Checking this device for a saved backlog.');
subscribeAuthState(next => { void handleAuthStateChange(next); });
window.addEventListener('focus', () => {
  const pendingSince = signInStartedAt;
  if (authState.status !== 'signing-in' || pendingSince === null || Date.now() - pendingSince < 1500) return;
  window.setTimeout(() => {
    if (authState.status !== 'signing-in' || signInStartedAt !== pendingSince) return;
    cancelGoogleSignIn();
    setStatusMessage('Google sign-in canceled. You can try again.');
  }, 500);
});
void loadInitialData();
void initializeAuth().catch(() => undefined);
void installNativeCloseHandler();
