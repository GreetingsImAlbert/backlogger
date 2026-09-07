import './style.css';
import { open as openNativeFile, save as saveNativeFile } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { compactDate, compactDateList, dateLabel, localToday, normalizeDates, parseDate, shiftDate, weekStart } from './dates';
import type { Category, Notebook, Task } from './model';
import { makeStoredDocument, parseStoredText, readDocumentFile, readStoredBackup, readStoredDocument, setNativeTheme, storageKind, writeDocumentFile, writeStoredDocument, type StoredDocument, type Theme, type ViewMode } from './storage';
import { applySyncConflict, ensureSyncDirectory, findCommonSnapshotAncestor, hasCompleteSnapshotAncestry, hasValidSnapshotParentRevisions, isSnapshotAncestor, listSyncFiles, loadSyncState, makeCheckpointSnapshot, makeSyncManifest, makeSyncSnapshot, makeSyncState, mergeNotebooks, notebookFingerprint, notebookFromSnapshot, parseSyncManifest, parseSyncSnapshot, readOptionalSyncFile, removeSyncFile, saveSyncState, snapshotFingerprint, storedDocumentFromSyncSnapshot, syncManifestPath, syncRootPath, syncSnapshotPath, syncSnapshotsPath, SYNC_SNAPSHOT_RETENTION_LIMIT, writeSyncJson, type SyncConflict, type SyncManifest, type SyncSnapshot, type SyncState } from './sync';

const root = document.querySelector<HTMLDivElement>('#app');
if (!root) throw new Error('App container is missing.');
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
let syncDeferred = false;
type SessionPhase = 'loading' | 'fetching' | 'ready' | 'offline' | 'closing';
interface AvailableUpdate {
  snapshot: SyncSnapshot;
  branchCount: number;
}
let sessionPhase: SessionPhase = 'loading';
let sessionContentDirty = false;
let statusMessage = '';
let availableUpdate: AvailableUpdate | null = null;
let ignoredUpdateIds = new Set<string>();
let closeInProgress = false;
let syncRetentionMessage = '';
let sessionFetchInFlight: Promise<void> | null = null;
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
viewSwitch.append(allView, todayView);
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
const statusActions = element('div', 'status-actions');
const fetchUpdateButton = button('Fetch', () => void fetchAvailableUpdate(), 'quiet-button');
const ignoreUpdateButton = button('Ignore', () => ignoreAvailableUpdate(), 'quiet-button');
const retryFetchButton = button('Retry fetch', () => void retrySessionFetch(), 'quiet-button');
fetchUpdateButton.hidden = true;
ignoreUpdateButton.hidden = true;
retryFetchButton.hidden = true;
statusActions.append(fetchUpdateButton, ignoreUpdateButton, retryFetchButton);
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
  renderStatusBar();
}

function renderStatusBar() {
  const update = availableUpdate;
  status.textContent = update
    ? update.branchCount > 1 ? `${update.branchCount} shared updates available.` : 'Shared update available.'
    : statusMessage;
  fetchUpdateButton.hidden = !update;
  ignoreUpdateButton.hidden = !update;
  retryFetchButton.hidden = sessionPhase !== 'offline' || !syncState.lastError;
  const editingReady = sessionPhase === 'ready' || sessionPhase === 'offline';
  fetchUpdateButton.disabled = !editingReady;
  ignoreUpdateButton.disabled = !editingReady;
  retryFetchButton.disabled = sessionPhase === 'fetching' || sessionPhase === 'closing';
  statusBar.hidden = !status.textContent && statusActions.querySelector('button:not([hidden])') === null;
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
  const stored = makeStoredDocument(notebook, revision, viewMode, theme);
  const raw = JSON.stringify(stored, null, 2);
  try {
    if (storageKind() === 'desktop') {
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
      if (syncSnapshot && storageKind() === 'desktop' && syncState.status !== 'disconnected') {
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
  return withTimeout(operation, SYNC_CHECK_TIMEOUT_MS, 'The shared-folder check timed out.');
}

function syncStatusLabel(): string {
  if (storageKind() !== 'desktop') return 'Desktop app only';
  if (!syncReady) return syncLoadError ? 'Unavailable' : 'Loading…';
  if (!syncState.folderPath || syncState.status === 'disconnected') return 'Not connected';
  if (syncState.status === 'paused') return 'Paused';
  if (syncState.conflicts.length) return 'Conflicts';
  if (syncState.lastError) return 'Folder unavailable';
  return 'Connected';
}

function syncStatusDetail(): string {
  if (storageKind() !== 'desktop') return 'Folder sync is available in the installed desktop app.';
  if (syncLoadError) return `Sync settings could not be loaded: ${syncLoadError}`;
  if (!syncState.folderPath || syncState.status === 'disconnected') return 'Choose a folder managed by OneDrive or Google Drive for desktop.';
  const pending = syncState.pendingSnapshots.length;
  if (syncState.conflicts.length) return `${syncState.conflicts.length} conflict${syncState.conflicts.length === 1 ? '' : 's'} need attention.`;
  if (syncState.lastError) return `Folder check failed: ${syncState.lastError}`;
  if (syncState.status === 'paused') return `${pending} pending snapshot${pending === 1 ? '' : 's'} saved locally.`;
  const checked = formatSyncCheckTime(syncState.lastSuccessfulCheckAt);
  const checkedDetail = checked ? ` Folder checked locally ${checked}.` : '';
  const retentionDetail = syncRetentionMessage ? ` ${syncRetentionMessage}` : '';
  return pending
    ? `${pending} snapshot${pending === 1 ? '' : 's'} waiting for the folder.${checkedDetail}${retentionDetail}`
    : `Local changes publish when you close the app.${checkedDetail}${retentionDetail} Provider upload/download is handled by its desktop app.`;
}

async function readSyncManifest(folderPath: string): Promise<SyncManifest | null> {
  const raw = await readOptionalSyncFile(syncManifestPath(folderPath));
  if (!raw) return null;
  try {
    return parseSyncManifest(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`The selected folder has an invalid notebook manifest: ${errorText(error)}`);
  }
}

async function writeSnapshotIfNeeded(folderPath: string, snapshot: SyncSnapshot): Promise<void> {
  const path = syncSnapshotPath(folderPath, snapshot.snapshotId);
  const serialized = JSON.stringify(snapshot, null, 2);
  const existing = await readOptionalSyncFile(path);
  if (existing !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing) as unknown;
    } catch {
      throw new Error(`Snapshot ${snapshot.snapshotId} is not valid JSON.`);
    }
    if (JSON.stringify(parsed) !== JSON.stringify(snapshot)) {
      throw new Error(`Snapshot ${snapshot.snapshotId} already exists with different content.`);
    }
    return;
  }
  await writeSyncJson(path, JSON.parse(serialized) as unknown);
}

async function compactSyncHistory(folderPath: string): Promise<boolean> {
  if (!syncState.notebookId || syncState.pendingSnapshots.length || syncState.conflicts.length) return false;
  let createdSnapshots: SyncSnapshot[] = [];
  let manifestPublished = false;
  try {
    const snapshots = await readSnapshotIndex(folderPath);
    if (snapshots.size <= SYNC_SNAPSHOT_RETENTION_LIMIT) return false;
    const originalManifest = await readSyncManifest(folderPath);
    if (!originalManifest || originalManifest.notebookId !== syncState.notebookId) return false;
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
    for (const snapshot of createdSnapshots) await writeSnapshotIfNeeded(folderPath, snapshot);

    const latestSnapshots = await readSnapshotIndex(folderPath);
    const latestManifest = await readSyncManifest(folderPath);
    const manifestsMatch = latestManifest
      && JSON.stringify([...latestManifest.headSnapshotIds].sort()) === JSON.stringify([...originalManifest.headSnapshotIds].sort())
      && JSON.stringify([...latestManifest.prunedSnapshotIds].sort()) === JSON.stringify([...originalManifest.prunedSnapshotIds].sort());
    const unchangedHistory = latestManifest
      && latestManifest.notebookId === syncState.notebookId
      && manifestsMatch
      && latestSnapshots.size === snapshots.size + createdSnapshots.length
      && [...snapshots.keys()].every(snapshotId => latestSnapshots.has(snapshotId));
    if (!unchangedHistory) {
      for (const snapshot of createdSnapshots) await removeSyncFile(syncSnapshotPath(folderPath, snapshot.snapshotId));
      return false;
    }

    const newHead = createdSnapshots.at(-1)!;
    await writeSyncJson(syncManifestPath(folderPath), {
      ...latestManifest,
      headSnapshotIds: [newHead.snapshotId],
      prunedSnapshotIds: [...new Set([...latestManifest.prunedSnapshotIds, ...snapshots.keys()])],
    });
    manifestPublished = true;
    for (const snapshotId of snapshots.keys()) {
      try {
        await removeSyncFile(syncSnapshotPath(folderPath, snapshotId));
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
        try { await removeSyncFile(syncSnapshotPath(folderPath, snapshot.snapshotId)); } catch { /* best-effort cleanup */ }
      }
    }
    console.warn('Could not compact sync history:', error);
    return false;
  }
}

async function publishPendingSnapshots(): Promise<number> {
  if (storageKind() !== 'desktop' || !syncReady || syncState.status !== 'connected' || !syncState.folderPath || !syncState.notebookId || syncState.conflicts.length) return 0;
  const checkedAt = startSyncCheck();
  const folderPath = syncState.folderPath;
  await ensureSyncDirectory(syncRootPath(folderPath));
  await ensureSyncDirectory(syncSnapshotsPath(folderPath));
  let manifest = await readSyncManifest(folderPath);
  if (!manifest) throw new Error('The connected folder is missing its notebook manifest.');
  if (manifest.notebookId !== syncState.notebookId) throw new Error('The connected folder belongs to a different notebook.');
  let published = 0;
  for (const snapshot of [...syncState.pendingSnapshots]) {
    if (snapshot.notebookId !== syncState.notebookId) throw new Error('A pending snapshot belongs to a different notebook.');
    const availableSnapshots = await readSnapshotIndex(folderPath, new Set(manifest.prunedSnapshotIds));
    const missingParent = snapshot.parentSnapshotIds.find(parentId => !availableSnapshots.has(parentId));
    if (missingParent) {
      throw new Error(`The pending snapshot is based on history that is no longer available (${missingParent}). Fetch the shared checkpoint before publishing local work.`);
    }
    await writeSnapshotIfNeeded(folderPath, snapshot);
    const latestManifest = await readSyncManifest(folderPath);
    if (!latestManifest || latestManifest.notebookId !== syncState.notebookId) {
      throw new Error('The notebook manifest changed while publishing.');
    }
    manifest = {
      ...latestManifest,
      headSnapshotIds: [...new Set([...latestManifest.headSnapshotIds, ...snapshot.parentSnapshotIds, snapshot.snapshotId])],
    };
    await writeSyncJson(syncManifestPath(folderPath), manifest);
    syncState.pendingSnapshots = syncState.pendingSnapshots.filter(item => item.snapshotId !== snapshot.snapshotId);
    syncState.knownHeadSnapshotIds = [...new Set([...syncState.knownHeadSnapshotIds, ...manifest.headSnapshotIds])];
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
  await compactSyncHistory(folderPath);
  return published;
}

async function readSnapshotIndex(folderPath: string, excludedSnapshotIds = new Set<string>()): Promise<Map<string, SyncSnapshot>> {
  const files = await listSyncFiles(syncSnapshotsPath(folderPath));
  const snapshots = new Map<string, SyncSnapshot>();
  for (const fileName of files.filter(name => name.toLowerCase().endsWith('.json'))) {
    const path = syncSnapshotsPath(folderPath).replace(/[\\/]$/, '') + (syncSnapshotsPath(folderPath).includes('\\') ? '\\' : '/') + fileName;
    const raw = await readOptionalSyncFile(path);
    if (raw === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    let snapshot: SyncSnapshot;
    try {
      snapshot = parseSyncSnapshot(parsed, `Snapshot ${fileName}`);
    } catch {
      continue;
    }
    if (snapshot.notebookId !== syncState.notebookId) throw new Error(`Snapshot ${fileName} belongs to a different notebook.`);
    const existing = snapshots.get(snapshot.snapshotId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) {
      throw new Error(`Snapshot ${snapshot.snapshotId} has conflicting copies.`);
    }
    snapshots.set(snapshot.snapshotId, snapshot);
  }
  for (const [snapshotId, snapshot] of snapshots) {
    if (!hasValidSnapshotParentRevisions(snapshot, snapshots)) snapshots.delete(snapshotId);
  }
  excludedSnapshotIds.forEach(snapshotId => snapshots.delete(snapshotId));
  return snapshots;
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

function snapshotLeaves(snapshots: Map<string, SyncSnapshot>): SyncSnapshot[] {
  const parents = new Set<string>();
  snapshots.forEach(snapshot => snapshot.parentSnapshotIds.forEach(parentId => parents.add(parentId)));
  return [...snapshots.values()]
    .filter(snapshot => !parents.has(snapshot.snapshotId) && hasCompleteSnapshotAncestry(snapshot, snapshots))
    .sort((first, second) => first.createdAt.localeCompare(second.createdAt));
}

function taskEditorIsOpen(): boolean {
  return [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].some(dialog => dialog !== syncDialogElement);
}

function acceptedSnapshotId(): string | null {
  return syncState.currentSnapshotId ?? syncState.lastPublishedSnapshotId;
}

async function scanSharedUpdate(includeIgnored = false): Promise<AvailableUpdate | null> {
  if (storageKind() !== 'desktop' || !syncReady || syncState.status !== 'connected' || !syncState.folderPath || !syncState.notebookId) return null;
  const folderPath = syncState.folderPath;
  const manifest = await readSyncManifest(folderPath);
  if (!manifest || manifest.notebookId !== syncState.notebookId) throw new Error('The connected folder has no matching notebook manifest.');
  const snapshots = await readSnapshotIndex(folderPath, new Set(manifest.prunedSnapshotIds));
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

async function checkForSharedUpdate(allowFetching = false) {
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

async function applyFetchedSnapshot(snapshot: SyncSnapshot): Promise<void> {
  const localDocument = makeStoredDocument(notebook, revision, viewMode, theme);
  await writeStoredDocument(localDocument);
  notebook = notebookFromSnapshot(snapshot);
  revision = Math.max(revision, snapshot.revision);
  syncState.currentSnapshotId = snapshot.snapshotId;
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

async function runSessionFetch() {
  if (!syncReady || syncState.status !== 'connected') {
    sessionPhase = 'ready';
    render();
    return;
  }
  sessionPhase = 'fetching';
  setStatusMessage('Fetching shared updates…');
  render();
  const update = await checkForSharedUpdate(true);
  if (!update) {
    sessionPhase = syncState.lastError ? 'offline' : 'ready';
    setStatusMessage(syncState.lastError ? 'Working offline. Shared updates will be checked again.' : 'Ready.');
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
  const operation = runSessionFetch();
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

function askFetchConfirmation(): Promise<boolean> {
  return new Promise(resolve => {
    const editor = openDialog('Replace local backlog?');
    editor.body.append(
      element('p', '', 'Fetching this shared version will replace the visible list with the validated shared snapshot.'),
      element('p', 'advisory', 'Your current local backlog will be backed up first. Continue only if you want to discard the local edits from this session.'),
    );
    editor.save.textContent = 'Fetch and replace';
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

async function fetchAvailableUpdate() {
  if (!availableUpdate || (sessionPhase !== 'ready' && sessionPhase !== 'offline')) return;
  const requestedId = availableUpdate.snapshot.snapshotId;
  sessionPhase = 'fetching';
  setStatusMessage('Fetching shared update…');
  render();
  const fresh = await checkForSharedUpdate(true);
  if (!fresh || fresh.snapshot.snapshotId !== requestedId) {
    if (!fresh) availableUpdate = null;
    sessionPhase = syncState.lastError ? 'offline' : 'ready';
    setStatusMessage(syncState.lastError ? 'Could not recheck the shared update. Retry when the folder is available.' : fresh ? 'A newer shared update is available.' : 'That shared update is no longer available.');
    render();
    return;
  }
  if (fresh.branchCount > 1) {
    sessionPhase = 'ready';
    setStatusMessage('Multiple shared branches are available. Open Sync to resolve them explicitly.');
    render();
    return;
  }
  if (sessionContentDirty && !(await askFetchConfirmation())) {
    sessionPhase = 'ready';
    availableUpdate = fresh;
    setStatusMessage('Fetch canceled; local edits were kept.');
    render();
    return;
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

function ignoreAvailableUpdate() {
  if (!availableUpdate) return;
  ignoredUpdateIds.add(availableUpdate.snapshot.snapshotId);
  availableUpdate = null;
  setStatusMessage('Shared update ignored for this session.');
  render();
}

async function reconcileSync(): Promise<{ applied: number; conflicts: number }> {
  if (storageKind() !== 'desktop' || !syncReady || syncState.status !== 'connected' || !syncState.folderPath || !syncState.notebookId) return { applied: 0, conflicts: 0 };
  if (taskEditorIsOpen()) {
    syncDeferred = true;
    return { applied: 0, conflicts: syncState.conflicts.length };
  }
  if (syncState.conflicts.length) return { applied: 0, conflicts: syncState.conflicts.length };
  const folderPath = syncState.folderPath;
  const manifest = await readSyncManifest(folderPath);
  if (!manifest || manifest.notebookId !== syncState.notebookId) throw new Error('The connected folder has no matching notebook manifest.');
  const snapshots = await readSnapshotIndex(folderPath, new Set(manifest.prunedSnapshotIds));
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
        const baseSnapshot = snapshots.get(workingId);
        const merge = mergeNotebooks(
          baseSnapshot ? { categories: baseSnapshot.categories } : null,
          workingNotebook,
          { categories: candidate.categories },
          workingId,
          candidate.snapshotId,
        );
        workingNotebook = merge.notebook;
        syncState.pendingSnapshots = [];
        syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(candidate.snapshotId, snapshots)])];
        syncState.mergeParentSnapshotIds = [...new Set([...syncState.mergeParentSnapshotIds, workingId, candidate.snapshotId])];
        if (merge.conflicts.length) {
          syncState.conflicts = merge.conflicts;
          syncState.lastError = null;
          syncState.currentSnapshotId = null;
          notebook = workingNotebook;
          revision = Math.max(revision, candidate.revision);
          await saveSyncState(syncState);
          queueSave(false);
          render();
          setStatusMessage(`${merge.conflicts.length} sync conflict${merge.conflicts.length === 1 ? '' : 's'} need attention.`);
          return { applied, conflicts: merge.conflicts.length };
        }
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
    const baseId = findCommonSnapshotAncestor(workingId, candidate.snapshotId, snapshots);
    const base = baseId ? snapshots.get(baseId) : null;
    const merge = mergeNotebooks(
      base ? { categories: base.categories } : null,
      workingNotebook,
      { categories: candidate.categories },
      workingId,
      candidate.snapshotId,
    );
    workingNotebook = merge.notebook;
    if (syncState.pendingSnapshots.length) syncState.pendingSnapshots = [];
    syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(candidate.snapshotId, snapshots)])];
    syncState.mergeParentSnapshotIds = [...new Set([...syncState.mergeParentSnapshotIds, workingId, candidate.snapshotId])];
    if (merge.conflicts.length) {
      syncState.conflicts = merge.conflicts;
      syncState.lastError = null;
      notebook = workingNotebook;
      revision = Math.max(revision, candidate.revision);
      await saveSyncState(syncState);
      queueSave(false);
      render();
      setStatusMessage(`${merge.conflicts.length} sync conflict${merge.conflicts.length === 1 ? '' : 's'} need attention.`);
      return { applied, conflicts: merge.conflicts.length };
    }
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
      setStatusMessage('Merged a remote snapshot; publishing the merged backlog.');
    }
  } else {
    await saveSyncState(syncState);
  }
  return { applied, conflicts: syncState.conflicts.length };
}

async function queueSyncSnapshot(document: StoredDocument): Promise<void> {
  if (!syncReady || storageKind() !== 'desktop' || !syncState.notebookId || !syncState.folderPath || syncState.status === 'disconnected' || syncState.conflicts.length) return;
  try {
    await enqueueSyncMutation(async () => {
      if (!syncState.notebookId || !syncState.folderPath || syncState.status === 'disconnected') return;
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

async function connectSyncFolder(folderPath: string): Promise<boolean> {
  if (storageKind() !== 'desktop') throw new Error('Folder sync is available in the desktop app.');
  const trimmedPath = folderPath.trim();
  if (!trimmedPath) throw new Error('Choose a folder first.');
  return enqueueSyncMutation(async () => {
    const checkedAt = startSyncCheck();
    await ensureSyncDirectory(syncRootPath(trimmedPath));
    await ensureSyncDirectory(syncSnapshotsPath(trimmedPath));
    const existingManifest = await readSyncManifest(trimmedPath);
    if (existingManifest && syncState.notebookId && existingManifest.notebookId !== syncState.notebookId) {
      throw new Error('This folder belongs to a different Backlogger notebook.');
    }
    const existing = Boolean(existingManifest);
    if (!syncState.notebookId) syncState.notebookId = existingManifest?.notebookId ?? crypto.randomUUID();
    const manifest = existingManifest ?? makeSyncManifest(syncState.notebookId, syncState.deviceId);
    let sharedHead: SyncSnapshot | null = null;
    let sharedSnapshots: Map<string, SyncSnapshot> | null = null;
    if (existingManifest && !syncState.currentSnapshotId && notebook.categories.length === 0) {
      sharedSnapshots = await readSnapshotIndex(trimmedPath, new Set(manifest.prunedSnapshotIds));
      sharedHead = snapshotLeaves(sharedSnapshots).at(-1) ?? null;
    }
    syncState.folderPath = trimmedPath;
    syncState.status = 'connected';
    syncState.knownHeadSnapshotIds = [...new Set(manifest.headSnapshotIds)];
    syncState.lastError = null;
    await saveSyncState(syncState);
    if (!existingManifest) await writeSyncJson(syncManifestPath(trimmedPath), manifest);
    if (sharedHead) {
      notebook = { categories: sharedHead.categories.map(category => ({ ...category, tasks: category.tasks.map(task => ({ ...task, scheduledDates: [...task.scheduledDates] })) })) };
      revision = Math.max(revision, sharedHead.revision);
      syncState.currentSnapshotId = sharedHead.snapshotId;
      syncState.lastPublishedRevision = revision + 1;
      syncState.lastPublishedContentFingerprint = snapshotFingerprint(sharedHead);
      syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, ...snapshotAncestry(sharedHead.snapshotId, sharedSnapshots!)])];
      syncState.pendingSnapshots = [];
      finishSyncCheck(checkedAt);
      await saveSyncState(syncState);
      render();
      queueSave(false);
      return existing;
    }
    if (existingManifest && (syncState.currentSnapshotId || syncState.lastPublishedSnapshotId)) {
      const result = await reconcileSync();
      if (result.conflicts) return existing;
    }
    const currentDocument = makeStoredDocument(notebook, revision, viewMode, theme);
    if (!syncState.pendingSnapshots.length && (!existingManifest || syncState.lastPublishedRevision !== currentDocument.revision)) {
      const parents = syncState.mergeParentSnapshotIds.length
        ? syncState.mergeParentSnapshotIds
        : syncState.currentSnapshotId
          ? [syncState.currentSnapshotId]
          : syncState.lastPublishedSnapshotId
            ? [syncState.lastPublishedSnapshotId]
            : manifest.headSnapshotIds;
      syncState.pendingSnapshots.push(makeSyncSnapshot(currentDocument, syncState, parents));
      await saveSyncState(syncState);
    }
    try {
      await publishPendingSnapshots();
    } catch (error) {
      syncState.lastError = errorText(error);
      await saveSyncState(syncState);
      throw error;
    }
    return existing;
  });
}

async function disconnectSync(): Promise<void> {
  await enqueueSyncMutation(async () => {
    syncState.status = 'disconnected';
    syncState.folderPath = null;
    syncState.lastError = null;
    await saveSyncState(syncState);
  });
}

async function toggleSyncPause(): Promise<void> {
  await enqueueSyncMutation(async () => {
    if (!syncState.folderPath || syncState.status === 'disconnected') throw new Error('Connect a folder first.');
    syncState.status = syncState.status === 'paused' ? 'connected' : 'paused';
    syncState.lastError = null;
    await saveSyncState(syncState);
    if (syncState.status === 'connected') await checkForSharedUpdate();
  });
}

async function syncNow(): Promise<number> {
  if (syncState.status === 'paused') throw new Error('Resume folder checks before searching for updates.');
  if (syncState.status === 'disconnected') throw new Error('Connect a folder first.');
  const update = await checkForSharedUpdate();
  return update ? 1 : 0;
}

function openSyncDialog() {
  const editor = openDialog('Sync');
  syncDialogElement = editor.dialog;
  editor.dialog.addEventListener('close', () => {
    if (syncDialogElement === editor.dialog) syncDialogElement = null;
  }, { once: true });
  let selectedFolder = syncState.folderPath;
  let createNotebookConfirmed = false;
  const intro = element('p', '', 'Use a local folder already synchronized by OneDrive or Google Drive for desktop.');
  const statusLine = element('p', 'import-summary');
  const folderLine = element('p', 'import-summary');
  const controls = element('div', 'sync-controls');
  const choose = button('Choose folder', () => void chooseFolder());
  const syncNowButton = button('Check for updates', () => void runSyncNow());
  const pauseButton = button(syncState.status === 'paused' ? 'Resume' : 'Pause', () => void togglePause());
  const disconnectButton = button('Disconnect', () => void disconnect());
  const resolveButton = button('Resolve conflicts', () => void resolveConflicts());
  controls.append(choose, syncNowButton, pauseButton, disconnectButton, resolveButton);
  editor.body.append(intro, statusLine, folderLine, controls);
  editor.save.textContent = syncState.folderPath && syncState.status !== 'disconnected' ? 'Done' : 'Connect';

  function refresh() {
    statusLine.textContent = `${syncStatusLabel()} · ${syncStatusDetail()}`;
    folderLine.textContent = selectedFolder ? `Folder: ${selectedFolder}` : 'No folder selected.';
    const connected = syncState.status !== 'disconnected' && Boolean(syncState.folderPath);
    choose.disabled = storageKind() !== 'desktop' || !syncReady;
    syncNowButton.disabled = !connected || syncState.status === 'paused';
    pauseButton.disabled = !connected;
    disconnectButton.disabled = !connected;
    resolveButton.disabled = !syncState.conflicts.length;
    pauseButton.textContent = syncState.status === 'paused' ? 'Resume' : 'Pause';
    editor.save.textContent = connected && selectedFolder === syncState.folderPath ? 'Done' : 'Connect';
    editor.save.disabled = storageKind() !== 'desktop' || !syncReady;
  }

  async function chooseFolder() {
    try {
      const path = await openNativeFile({ title: 'Choose Backlogger sync folder', directory: true, multiple: false });
      if (typeof path === 'string') {
        selectedFolder = path;
        createNotebookConfirmed = false;
        refresh();
      }
    } catch (error) {
      editor.error.textContent = `Folder picker failed: ${errorText(error)}`;
    }
  }

  async function connect() {
    if (!selectedFolder) { editor.error.textContent = 'Choose a folder first.'; return; }
    editor.error.textContent = '';
    editor.save.disabled = true;
    try {
      const existingManifest = await readSyncManifest(selectedFolder);
      if (!existingManifest && !createNotebookConfirmed) {
        createNotebookConfirmed = true;
        editor.error.textContent = 'No shared notebook was found. Press Connect again to create a new notebook here, or cancel and wait for the provider to finish downloading.';
        refresh();
        return;
      }
      const joinedExisting = await connectSyncFolder(selectedFolder);
      setStatusMessage(joinedExisting
        ? 'Connected. Local snapshots are publishing; checking the shared notebook for remote changes.'
        : 'Connected. The initial snapshot was published.');
      refresh();
      editor.dialog.close();
      void attemptPendingSync();
    } catch (error) {
      syncState.lastCheckedAt = syncState.lastCheckedAt ?? syncCheckTime();
      syncState.lastError = errorText(error);
      try { await saveSyncState(syncState); } catch { /* keep the connection error visible in the dialog */ }
      editor.error.textContent = `Could not connect: ${errorText(error)}`;
      refresh();
    }
  }

  async function runSyncNow() {
    editor.error.textContent = '';
    try {
      const count = await syncNow();
      setStatusMessage(syncState.conflicts.length
        ? `${syncState.conflicts.length} sync conflict${syncState.conflicts.length === 1 ? '' : 's'} need attention.`
        : count ? 'Shared update available.' : 'No shared update found.');
      refresh();
    } catch (error) {
      editor.error.textContent = `Sync failed: ${errorText(error)}`;
      refresh();
    }
  }

  async function resolveConflicts() {
    editor.dialog.close();
    openConflictDialog();
  }

  async function togglePause() {
    editor.error.textContent = '';
    try {
      await toggleSyncPause();
      setStatusMessage(syncState.status === 'paused' ? 'Folder sync paused; local saves continue.' : 'Folder sync resumed.');
      refresh();
    } catch (error) {
      editor.error.textContent = `Could not change sync state: ${errorText(error)}`;
      refresh();
    }
  }

  async function disconnect() {
    editor.error.textContent = '';
    try {
      await disconnectSync();
      selectedFolder = null;
      setStatusMessage('Disconnected. Local tasks and pending snapshots were kept.');
      refresh();
    } catch (error) {
      editor.error.textContent = `Could not disconnect: ${errorText(error)}`;
      refresh();
    }
  }

  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    if (syncState.status !== 'disconnected' && selectedFolder === syncState.folderPath) {
      editor.dialog.close();
      return;
    }
    void connect();
  });
  refresh();
}

function conflictValueLabel(value: unknown): string {
  if (value === null || value === undefined) return 'Deleted';
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  return serialized.length > 220 ? `${serialized.slice(0, 217)}…` : serialized;
}

function conflictLabel(conflict: SyncConflict): string {
  if (conflict.target === 'category-order') return 'Category order changed on both devices.';
  if (conflict.target === 'task-order') return 'Task order changed on both devices.';
  const record = conflict.target === 'task' ? `Task ${conflict.recordId}` : `Category ${conflict.recordId}`;
  return conflict.field === 'record' ? `${record} was deleted on one device and edited on the other.` : `${record} has two values for ${conflict.field}.`;
}

function openConflictDialog() {
  if (!syncState.conflicts.length) return;
  const editor = openDialog(`Resolve ${syncState.conflicts.length} conflict${syncState.conflicts.length === 1 ? '' : 's'}`);
  editor.save.textContent = 'Close';
  const list = element('div', 'conflict-list');
  editor.body.append(element('p', '', 'Choose which value should become the shared value. Each choice is saved locally; the final choice publishes a merge snapshot.'), list);

  function draw() {
    list.replaceChildren();
    syncState.conflicts.forEach(conflict => {
      const item = element('section', 'conflict-item');
      item.append(element('strong', '', conflictLabel(conflict)));
      const values = element('div', 'conflict-values');
      values.append(
        element('p', '', `Mine: ${conflictValueLabel(conflict.localValue)}`),
        element('p', '', `Other: ${conflictValueLabel(conflict.remoteValue)}`),
      );
      const actions = element('div', 'sync-controls');
      actions.append(
        button('Keep mine', () => void resolve(conflict, conflict.localValue)),
        button('Use other', () => void resolve(conflict, conflict.remoteValue)),
      );
      item.append(values, actions);
      list.append(item);
    });
  }

  async function resolve(conflict: SyncConflict, value: unknown) {
    notebook = applySyncConflict(notebook, conflict, value);
    syncState.conflicts = syncState.conflicts.filter(item => item.conflictId !== conflict.conflictId);
    syncState.lastError = null;
    render();
    try {
      await saveSyncState(syncState);
      queueSave(syncState.conflicts.length === 0);
      if (syncState.conflicts.length === 0) {
        setStatusMessage('Conflicts resolved; publishing the merge.');
        editor.dialog.close();
      } else {
        setStatusMessage(`${syncState.conflicts.length} sync conflict${syncState.conflicts.length === 1 ? '' : 's'} remain.`);
        draw();
      }
    } catch (error) {
      editor.error.textContent = `Could not save the conflict choice: ${errorText(error)}`;
      syncState.conflicts.push(conflict);
      render();
      draw();
    }
  }

  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    editor.dialog.close();
  });
  draw();
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
  setStorageNotice('Saving locally…', storageKind() === 'desktop' ? 'Writing a versioned file in the app-data folder.' : 'Writing to browser local storage for this preview.');
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => writeStoredDocument(documentToSave))
    .then(async () => {
      if (publishSync) await queueSyncSnapshot(documentToSave);
      if (sequence === saveSequence) {
        hasUnsavedChanges = false;
        retrySaveButton.hidden = true;
        setStorageNotice('Saved locally', storageKind() === 'desktop' ? 'Your backlog is stored on this device.' : 'Preview data is stored in this browser.');
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
  return { dialog, form, body, error, save };
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
  return task.scheduledDates.includes(today);
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
  const scrollPosition = readScrollPosition();
  list.replaceChildren();
  const today = localToday();
  const editingReady = storageReady && !storageBlocked && !closeInProgress && (sessionPhase === 'ready' || sessionPhase === 'offline');
  allView.setAttribute('aria-pressed', String(viewMode === 'all'));
  todayView.setAttribute('aria-pressed', String(viewMode === 'today'));
  todayView.textContent = 'Today';
  todayView.title = dateLabel(today);
  addCategory.disabled = !editingReady;
  themeButton.disabled = !editingReady;
  allView.disabled = todayView.disabled = !editingReady;
  importButton.disabled = exportButton.disabled = !editingReady;
  syncButton.disabled = !storageReady || closeInProgress || (storageKind() === 'desktop' && !syncReady);
  undoButton.disabled = !editingReady;
  renderStatusBar();
  if (notebook.categories.length === 0) {
    const empty = element('section', 'empty-notebook');
    empty.append(element('p', '', storageReady ? 'No categories yet.' : 'Loading…'));
    list.append(empty);
  }
  let visibleCategoryCount = 0;
  notebook.categories.forEach(category => {
    const visibleTasks = viewMode === 'today' ? category.tasks.filter(task => isScheduledToday(task, today)) : category.tasks;
    if (viewMode === 'today' && visibleTasks.length === 0) return;
    visibleCategoryCount += 1;
    const section = element('section', 'category');
    const heading = element('h2', 'category-heading', category.name);
    heading.id = `category-${category.id}`;
    section.setAttribute('aria-labelledby', heading.id);
    const top = element('div', 'category-top');
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
    top.append(heading, controls);
    section.append(top);
    const tasks = element('ul', 'tasks');
    visibleTasks.forEach(task => {
      const taskIndex = category.tasks.indexOf(task);
      const row = element('li', 'task');
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
  if (viewMode === 'today' && visibleCategoryCount === 0 && notebook.categories.length > 0) {
    const empty = element('section', 'empty-notebook');
    empty.append(element('p', '', 'Nothing scheduled today.'));
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
  if (!syncState.folderPath || !syncState.notebookId || syncState.conflicts.length) return;
  const pendingBaseParents = syncState.pendingSnapshots[0]?.parentSnapshotIds ?? [];
  const parents = syncState.mergeParentSnapshotIds.length
    ? syncState.mergeParentSnapshotIds
    : syncState.currentSnapshotId
      ? [syncState.currentSnapshotId]
      : pendingBaseParents.length
        ? pendingBaseParents
        : syncState.knownHeadSnapshotIds;
  const snapshot = makeSyncSnapshot(
    makeStoredDocument(notebook, revision, viewMode, theme),
    syncState,
    parents,
  );

  // Closing performs one shared-folder operation: write the immutable snapshot.
  // If this does not finish, the unchanged content fingerprint makes the next
  // session recognize that the local notebook still needs publication.
  await writeSyncJson(syncSnapshotPath(syncState.folderPath, snapshot.snapshotId), snapshot);

  syncState.pendingSnapshots = [];
  syncState.currentSnapshotId = snapshot.snapshotId;
  syncState.knownHeadSnapshotIds = [...new Set([...syncState.knownHeadSnapshotIds, snapshot.snapshotId])];
  syncState.processedSnapshotIds = [...new Set([...syncState.processedSnapshotIds, snapshot.snapshotId])];
  syncState.lastPublishedSnapshotId = snapshot.snapshotId;
  syncState.lastPublishedRevision = snapshot.revision;
  syncState.lastPublishedContentFingerprint = snapshotFingerprint(snapshot);
  syncState.lastPublishedAt = new Date().toISOString();
  syncState.mergeParentSnapshotIds = [];
  syncState.lastError = null;
  await saveSyncState(syncState);
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
  if (syncState.status !== 'connected' || !syncState.folderPath || !syncState.notebookId) return true;

  const localNeedsPublish = sessionContentDirty || syncState.pendingSnapshots.length > 0;
  if (localNeedsPublish) {
    try {
      await withTimeout(
        writeCloseSnapshot(),
        CLOSE_SNAPSHOT_TIMEOUT_MS,
        'The snapshot write did not finish before closing.',
      );
      sessionContentDirty = false;
      return true;
    } catch (error) {
      syncState.lastError = errorText(error);
      return true;
    }
  }
  return true;
}

async function installNativeCloseHandler() {
  if (storageKind() !== 'desktop') return;
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
    setStorageNotice(stored ? 'Saved locally' : 'Local data ready', storageKind() === 'desktop' ? 'Your backlog is stored on this device.' : 'Preview data will be stored in this browser.');
    sessionPhase = syncReady && syncState.status === 'connected' ? 'fetching' : syncLoadError ? 'offline' : 'ready';
    render();
    if (syncReady && syncState.status === 'connected') void startSessionFetch();
    else setStatusMessage(syncLoadError ? 'Working offline. Sync settings could not be loaded.' : 'Ready.');
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
void loadInitialData();
void installNativeCloseHandler();
