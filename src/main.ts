import './style.css';
import { compactDate, compactDateList, dateLabel, localToday, normalizeDates, parseDate, shiftDate, weekStart } from './dates';
import type { Category, Notebook, Task } from './model';
import { makeStoredDocument, parseStoredText, readStoredBackup, readStoredDocument, setNativeTheme, storageKind, writeStoredDocument, type StoredDocument, type Theme, type ViewMode } from './storage';

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

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
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
    menu.querySelector('summary')?.focus();
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
  queueSave();
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
const list = element('div', 'categories');
const addCategory = button('+ Add category', () => editCategory(), 'add-category');
const exportButton = button('Export', exportCurrentDocument);
const importButton = button('Import', () => importInput.click());
const importInput = element('input');
importInput.type = 'file';
importInput.accept = 'application/json,.json';
importInput.hidden = true;
importInput.addEventListener('change', () => {
  const file = importInput.files?.[0];
  importInput.value = '';
  if (file) void inspectImport(file);
});
const status = element('div', 'status');
status.setAttribute('role', 'status');
const undoButton = button('Undo', () => {
  if (!undoState) return;
  notebook = undoState;
  clearUndo();
  render();
  queueSave();
  status.textContent = 'Deletion undone.';
  addCategory.focus();
});
undoButton.hidden = true;
const actions = element('div', 'bottom-actions');
headerActions.append(actionMenu('Backlogger options', [importButton, exportButton]));
actions.append(addCategory, importInput, undoButton, status);
main.append(header, notice, list, actions);
root.append(main);

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
  queueSave();
}

function taskCount(categories: Notebook['categories']): number {
  return categories.reduce((total, category) => total + category.tasks.length, 0);
}

function exportCurrentDocument() {
  const stored = makeStoredDocument(notebook, revision, viewMode, theme);
  const blob = new Blob([JSON.stringify(stored, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = element('a');
  link.href = url;
  link.download = `backlogger-${localToday()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  status.textContent = `Exported ${taskCount(stored.categories)} task(s) in ${stored.categories.length} categor${stored.categories.length === 1 ? 'y' : 'ies'}.`;
}

function showImportDialog(fileName: string, imported: StoredDocument) {
  const editor = openDialog('Import backlog?');
  editor.body.append(
    element('p', '', `Import “${fileName}” and replace the current list?`),
    element('p', 'import-summary', `${imported.categories.length} categor${imported.categories.length === 1 ? 'y' : 'ies'} and ${taskCount(imported.categories)} task(s) were validated.`),
  );
  editor.save.textContent = 'Import and save';
  editor.form.addEventListener('submit', event => {
    event.preventDefault();
    commit(() => {
      notebook = { categories: imported.categories };
      viewMode = imported.preferences.viewMode;
      revision = Math.max(revision, imported.revision);
      storageBlocked = false;
      recoverButton.hidden = true;
    }, `Imported ${fileName}.`, true);
    editor.dialog.close();
  });
}

async function inspectImport(file: File) {
  try {
    const imported = parseStoredText(await file.text());
    showImportDialog(file.name, imported);
  } catch (error) {
    status.textContent = `Import rejected: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function recoverBackup() {
  recoverButton.disabled = true;
  try {
    const backup = await readStoredBackup();
    if (!backup) {
      status.textContent = 'No valid local backup was found.';
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
    status.textContent = `Backup recovery failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    recoverButton.disabled = false;
  }
}

function queueSave() {
  if (!storageReady) return;
  hasUnsavedChanges = true;
  retrySaveButton.hidden = true;
  if (storageBlocked) {
    setStorageNotice('Saved data needs attention', 'Your edits remain open but are not being overwritten.');
    status.textContent = 'Saving is paused because the existing local data could not be validated.';
    return;
  }
  const documentToSave = makeStoredDocument(notebook, ++revision, viewMode, theme);
  const sequence = ++saveSequence;
  setStorageNotice('Saving locally…', storageKind() === 'desktop' ? 'Writing a versioned file in the app-data folder.' : 'Writing to browser local storage for this preview.');
  saveQueue = saveQueue
    .catch(() => undefined)
    .then(() => writeStoredDocument(documentToSave))
    .then(() => {
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
        status.textContent = `Could not save local data: ${error instanceof Error ? error.message : String(error)}`;
      }
    });
}

function clearUndo() {
  clearTimeout(undoTimer);
  undoState = null;
  undoButton.hidden = true;
}

function commit(change: () => void, message: string, canUndo = false) {
  clearUndo();
  if (canUndo) undoState = structuredClone(notebook);
  change();
  render();
  queueSave();
  status.textContent = canUndo ? message : '';
  undoButton.hidden = !canUndo;
  if (canUndo) {
    undoTimer = setTimeout(() => {
      const focused = document.activeElement === undoButton;
      clearUndo();
      status.textContent = '';
      if (focused) addCategory.focus();
    }, 15_000);
    undoButton.focus();
  }
}

function openDialog(title: string) {
  const previousFocus = document.activeElement as HTMLElement | null;
  const menuTrigger = previousFocus?.closest('details')?.querySelector('summary');
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
    if (menuTrigger?.isConnected) menuTrigger.focus();
    else if (previousFocus?.isConnected) previousFocus.focus();
    else if (undoState) undoButton.focus();
    else addCategory.focus();
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
  list.replaceChildren();
  const today = localToday();
  allView.setAttribute('aria-pressed', String(viewMode === 'all'));
  todayView.setAttribute('aria-pressed', String(viewMode === 'today'));
  todayView.textContent = 'Today';
  todayView.title = dateLabel(today);
  addCategory.disabled = !storageReady;
  themeButton.disabled = !storageReady;
  allView.disabled = todayView.disabled = !storageReady;
  importButton.disabled = exportButton.disabled = !storageReady;
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
    upCategory.disabled = categoryIndex === 0;
    upCategory.setAttribute('aria-label', `Move ${category.name} up`);
    const downCategory = button('Move down', () => moveCategory(category, 1));
    downCategory.disabled = categoryIndex === notebook.categories.length - 1;
    downCategory.setAttribute('aria-label', `Move ${category.name} down`);
    const add = iconButton('plus', `Add task to ${category.name}`, () => editTask(category));
    const rename = button('Rename', () => editCategory(category));
    rename.setAttribute('aria-label', `Rename ${category.name}`);
    const remove = button('Delete', () => removeCategory(category));
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
      const remove = button('Delete', () => commit(() => {
        category.tasks = category.tasks.filter(item => item.id !== task.id);
      }, `Deleted ${task.title}.`, true), 'quiet-button task-delete');
      remove.setAttribute('aria-label', `Delete task ${task.title}`);
      const upTask = button('Move up', () => moveTask(category, task, -1));
      upTask.disabled = taskIndex === 0;
      upTask.setAttribute('aria-label', `Move task ${task.title} up`);
      const downTask = button('Move down', () => moveTask(category, task, 1));
      downTask.disabled = taskIndex === category.tasks.length - 1;
      downTask.setAttribute('aria-label', `Move task ${task.title} down`);
      remove.className = 'quiet-button destructive';
      row.append(content, actionMenu(`Options for ${task.title}`, [button('Edit', () => editTask(category, task)), upTask, downTask, remove]));
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
window.addEventListener('focus', refreshDateState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshDateState();
});
setInterval(refreshDateState, 30_000);
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
    storageReady = true;
    recoverButton.hidden = true;
    setStorageNotice(stored ? 'Saved locally' : 'Local data ready', storageKind() === 'desktop' ? 'Your backlog is stored on this device.' : 'Preview data will be stored in this browser.');
    render();
  } catch (error) {
    storageReady = true;
    storageBlocked = true;
    recoverButton.hidden = false;
    setStorageNotice('Saved data needs attention', 'The existing local data was preserved and was not replaced.');
    status.textContent = `Could not load local data: ${error instanceof Error ? error.message : String(error)}`;
    render();
  }
}
applyTheme();
render();
setStorageNotice('Loading local data…', 'Checking this device for a saved backlog.');
void loadInitialData();
