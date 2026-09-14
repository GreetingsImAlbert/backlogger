import test from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryLocalRepository } from '../src/local-db/index.ts';
import {
  bindRepositoryToRecordSync,
  buildLegacyBootstrapPreview,
  makeV2BootstrapPayload,
  SupabaseRecordBootstrapGateway,
} from '../src/sync-v2/bootstrap.ts';
import { parseSyncManifest, parseSyncSnapshot } from '../src/sync.ts';
import { legacySyncGraphs } from './fixtures/legacy-sync-graphs.mjs';

const ACCOUNT = 'account-a';
const PROJECT = 'project-a';
const NOTEBOOK = 'notebook-v2';
const NOW = '2026-01-13T00:00:00.000Z';

function graph(fixture) {
  return {
    manifest: parseSyncManifest(fixture.manifest),
    snapshots: new Map(fixture.snapshots.map(value => {
      const snapshot = parseSyncSnapshot(value);
      return [snapshot.snapshotId, snapshot];
    })),
  };
}

function localNotebook() {
  return { categories: [{
    id: 'local-category',
    name: 'Local',
    tasks: [{ id: 'local-task', title: 'Keep locally', scheduledDates: [], deadlineDate: null }],
  }] };
}

test('legacy bootstrap unions every complete branch and local record without manual branch repair', () => {
  const branches = graph(legacySyncGraphs.multipleCompleteHeads);
  const preview = buildLegacyBootstrapPreview(localNotebook(), branches.manifest, branches.snapshots);

  assert.deepEqual(preview.completeLeafIds, ['branch-left', 'branch-right']);
  assert.deepEqual(preview.missingSnapshotIds, []);
  assert.equal(preview.categoryCount, 2);
  assert.equal(preview.taskCount, 3);
  assert.deepEqual(
    preview.notebook.categories.flatMap(category => category.tasks.map(task => task.id)).sort(),
    ['local-task', 'synthetic-task-branch-left', 'synthetic-task-branch-right'],
  );
});

test('latest legacy snapshot deterministically wins same-ID fields while local values remain loss-safe', () => {
  const base = legacySyncGraphs.multipleCompleteHeads.snapshots[0];
  const older = structuredClone(legacySyncGraphs.multipleCompleteHeads.snapshots[1]);
  const newer = structuredClone(legacySyncGraphs.multipleCompleteHeads.snapshots[2]);
  older.categories[0].tasks[0].id = 'shared-task';
  older.categories[0].tasks[0].title = 'Older title';
  newer.categories[0].tasks[0].id = 'shared-task';
  newer.categories[0].tasks[0].title = 'Newer title';
  const manifest = parseSyncManifest(legacySyncGraphs.multipleCompleteHeads.manifest);
  const snapshots = new Map([base, older, newer].map(value => {
    const parsed = parseSyncSnapshot(value);
    return [parsed.snapshotId, parsed];
  }));

  const legacyOnly = buildLegacyBootstrapPreview({ categories: [] }, manifest, snapshots);
  assert.equal(legacyOnly.notebook.categories[0].tasks[0].title, 'Newer title');

  const local = { categories: [{
    id: 'synthetic-category', name: 'Local category', tasks: [{
      id: 'shared-task', title: 'Local title', scheduledDates: ['2026-09-13'], deadlineDate: null,
    }],
  }] };
  const withLocal = buildLegacyBootstrapPreview(local, manifest, snapshots);
  assert.equal(withLocal.notebook.categories[0].name, 'Local category');
  assert.equal(withLocal.notebook.categories[0].tasks[0].title, 'Local title');
  assert.deepEqual(withLocal.notebook.categories[0].tasks[0].scheduledDates, ['2026-09-13']);
});

test('incomplete ancestry reports exact missing IDs while preserving the local preview', () => {
  const incomplete = graph(legacySyncGraphs.missingAncestry);
  const preview = buildLegacyBootstrapPreview(localNotebook(), incomplete.manifest, incomplete.snapshots);

  assert.deepEqual(preview.completeLeafIds, []);
  assert.deepEqual(preview.missingSnapshotIds, [legacySyncGraphs.missingAncestry.missingSnapshotId]);
  assert.deepEqual(preview.notebook, localNotebook());
});

class FakeBootstrapClient {
  constructor() {
    this.userId = ACCOUNT;
    this.notebooks = [];
    this.calls = [];
    this.auth = { getUser: async () => ({ data: { user: { id: this.userId } }, error: null }) };
  }

  from(table) {
    assert.equal(table, 'sync_v2_notebooks');
    return {
      select: () => ({
        eq: (_column, value) => ({
          range: async () => ({ data: this.notebooks.filter(row => row.owner_id === value), error: null }),
        }),
      }),
    };
  }

  async rpc(name, args) {
    this.calls.push({ name, args });
    const row = {
      notebook_id: args.p_notebook_id,
      owner_id: this.userId,
      created_at: NOW,
      updated_at: NOW,
      category_count: args.p_categories.length,
      task_count: args.p_tasks.length,
    };
    this.notebooks.push(row);
    return { data: [row], error: null };
  }
}

test('v2 discovery is read-only and initialization uses the atomic bootstrap RPC', async () => {
  const client = new FakeBootstrapClient();
  const gateway = new SupabaseRecordBootstrapGateway(ACCOUNT, { client, projectRef: PROJECT });
  assert.equal(await gateway.inspectNotebook(), null);

  const record = {
    recordType: 'category', id: 'category-a', name: 'Category', sortKey: '4000000000000000',
    updatedAt: NOW, version: 7, deletedAt: null, updatedByDeviceId: 'device-a',
    fieldUpdatedAt: { name: { at: NOW, deviceId: 'device-a' }, sortKey: { at: NOW, deviceId: 'device-a' } },
    changeSeq: 22,
  };
  const payload = makeV2BootstrapPayload({ categories: [record], tasks: [] });
  assert.equal(payload.categories[0].version, 0);
  assert.equal(payload.categories[0].changeSeq, 0);
  await gateway.initializeNotebook(NOTEBOOK, { categories: [record], tasks: [] });
  assert.equal(client.calls[0].name, 'initialize_sync_v2_notebook');
  assert.equal((await gateway.inspectNotebook()).notebook_id, NOTEBOOK);
});

test('binding a local repository queues every record once and preserves an existing v2 cursor on reconnect', async () => {
  let id = 0;
  const { repository } = createInMemoryLocalRepository(null, {
    now: () => NOW,
    createId: () => `bootstrap-${++id}`,
  });
  await repository.initialize(JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    preferences: { viewMode: 'all', theme: 'dark', colorTheme: 'neutral' },
    categories: [{ id: 'category-a', name: 'Category', tasks: [{
      id: 'task-a', title: 'Task', scheduledDates: [], deadlineDate: null,
    }] }],
  }));

  await bindRepositoryToRecordSync(repository, { accountId: ACCOUNT, projectRef: PROJECT, notebookId: NOTEBOOK });
  assert.equal((await repository.listOutbox()).length, 2);
  assert.ok((await repository.listOutbox()).every(entry => entry.expectedVersion === 0));

  const state = (await repository.readModel()).syncState;
  await repository.setSyncState({ ...state, lastChangeSeq: 9, status: 'disconnected' });
  await bindRepositoryToRecordSync(repository, { accountId: ACCOUNT, projectRef: PROJECT, notebookId: NOTEBOOK });
  assert.equal((await repository.readModel()).syncState.lastChangeSeq, 9);
  assert.equal((await repository.listOutbox()).length, 2);
});
