import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStoredDocument, parseStoredDocument, parseStoredText, readStoredBackup, SCHEMA_VERSION, writeStoredDocument } from '../src/storage.ts';

const notebook = {
  categories: [{
    id: 'category-1',
    name: 'ME 190',
    tasks: [{
      id: 'task-1',
      title: 'Presentation',
      scheduledDates: ['2026-09-07', '2026-09-09', '2026-09-07'],
      deadlineDate: '2026-09-11',
    }],
  }],
};

test('existing backlogs without a theme stay readable and light mode round-trips', () => {
  const original = makeStoredDocument(notebook, 4, 'today');
  const legacy = { ...original, preferences: { viewMode: 'today' } };
  const loaded = parseStoredDocument(legacy);
  assert.equal(loaded.preferences.theme, 'dark');
  assert.deepEqual(loaded.categories, original.categories);
  const light = makeStoredDocument(notebook, 5, 'all', 'light');
  assert.equal(parseStoredText(JSON.stringify(light)).preferences.theme, 'light');
  assert.throws(() => parseStoredDocument({ ...original, preferences: { viewMode: 'all', theme: 'invalid' } }), /theme/);
});

test('stored documents have a version, revision, preferences, and normalized dates', () => {
  const document = makeStoredDocument(notebook, 4, 'today');
  assert.equal(document.schemaVersion, SCHEMA_VERSION);
  assert.equal(document.revision, 4);
  assert.equal(document.preferences.viewMode, 'today');
  assert.deepEqual(document.categories[0].tasks[0].scheduledDates, ['2026-09-07', '2026-09-09']);
  assert.deepEqual(parseStoredDocument(JSON.parse(JSON.stringify(document))), document);
});

test('stored data rejects unsupported versions, invalid dates, and duplicate ids', () => {
  const document = makeStoredDocument(notebook, 0, 'all');
  assert.throws(() => parseStoredDocument({ ...document, schemaVersion: 99 }));
  assert.throws(() => parseStoredDocument({
    ...document,
    categories: [{ ...document.categories[0], tasks: [{ ...document.categories[0].tasks[0], deadlineDate: '2026-02-30' }] }],
  }));
  assert.throws(() => parseStoredDocument({
    ...document,
    categories: [document.categories[0], { ...document.categories[0], id: 'category-1' }],
  }));
});

test('import text reports malformed JSON and preserves validated preferences', () => {
  const document = makeStoredDocument(notebook, 8, 'today');
  assert.deepEqual(parseStoredText(JSON.stringify(document)), document);
  assert.throws(() => parseStoredText('{not json'), /not valid JSON/);
});

test('browser writes keep the last valid document as a backup', async () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
  try {
    const first = makeStoredDocument(notebook, 1, 'all');
    const second = makeStoredDocument({ categories: [] }, 2, 'today');
    await writeStoredDocument(first);
    await writeStoredDocument(second);
    assert.deepEqual(await readStoredBackup(), first);
  } finally {
    delete globalThis.window;
  }
});
