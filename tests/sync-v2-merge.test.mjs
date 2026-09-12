import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyServerRecord,
  cascadeCategoryTombstones,
  cloneSyncRecord,
  compareBySortKeyThenId,
  compareFieldClocks,
  generateEvenSortKeys,
  reconcileRecord,
  reorderCategorySortKeys,
  reorderTaskSortKeys,
  sortKeyBetween,
} from '../src/sync-v2/index.ts';

const NOW = Date.parse('2026-09-12T00:00:00.000Z');
const CLOCK_OPTIONS = { now: NOW };
const T0 = '2026-09-10T08:00:00.000Z';
const T1 = '2026-09-10T09:00:00.000Z';
const T2 = '2026-09-10T10:00:00.000Z';
const T3 = '2026-09-10T11:00:00.000Z';

function clock(at = T0, deviceId = 'device-base') {
  return { at, deviceId };
}

function category(overrides = {}) {
  return {
    recordType: 'category',
    id: 'category-1',
    name: 'Base name',
    sortKey: '4000000000000000',
    updatedAt: T0,
    version: 1,
    deletedAt: null,
    updatedByDeviceId: 'device-base',
    fieldUpdatedAt: { name: clock(), sortKey: clock() },
    changeSeq: 10,
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    recordType: 'task',
    id: 'task-1',
    categoryId: 'category-1',
    title: 'Base title',
    scheduledDates: ['2026-09-10'],
    deadlineDate: null,
    sortKey: '4000000000000000',
    updatedAt: T0,
    version: 1,
    deletedAt: null,
    updatedByDeviceId: 'device-base',
    fieldUpdatedAt: {
      categoryId: clock(),
      title: clock(),
      scheduledDates: clock(),
      deadlineDate: clock(),
      sortKey: clock(),
    },
    changeSeq: 10,
    ...overrides,
  };
}

function edit(record, field, value, at, deviceId) {
  const edited = cloneSyncRecord(record);
  edited[field] = Array.isArray(value) ? [...value] : value;
  edited.fieldUpdatedAt[field] = clock(at, deviceId);
  edited.updatedAt = at;
  edited.updatedByDeviceId = deviceId;
  return edited;
}

function remove(record, at, deviceId) {
  const deleted = cloneSyncRecord(record);
  deleted.deletedAt = at;
  deleted.updatedByDeviceId = deviceId;
  return deleted;
}

function canonical(record, version, changeSeq) {
  const accepted = cloneSyncRecord(record);
  accepted.version = version;
  accepted.changeSeq = changeSeq;
  return accepted;
}

function applyAssignments(records, assignments) {
  const keys = new Map((assignments ?? []).map(assignment => [assignment.id, assignment.sortKey]));
  return records
    .map(record => ({ ...record, sortKey: keys.get(record.id) ?? record.sortKey }))
    .sort(compareBySortKeyThenId);
}

test('one-sided changes upload local or apply server in either direction', () => {
  const base = category();
  const cases = [
    {
      name: 'only local changed',
      local: edit(base, 'name', 'Local name', T1, 'device-local'),
      server: base,
      action: 'upload-local',
      value: 'Local name',
      expectedVersion: 1,
    },
    {
      name: 'only server changed',
      local: base,
      server: canonical(edit(base, 'name', 'Server name', T1, 'device-server'), 2, 20),
      action: 'apply-server',
      value: 'Server name',
      expectedVersion: 2,
    },
  ];

  for (const item of cases) {
    const result = reconcileRecord(base, item.local, item.server, CLOCK_OPTIONS);
    assert.equal(result.action, item.action, item.name);
    assert.equal(result.record.name, item.value, item.name);
    assert.equal(result.expectedVersion, item.expectedVersion, item.name);
  }
});

test('different concurrent fields merge without treating metadata as business data', () => {
  const base = category();
  const local = edit(base, 'name', 'Local name', T2, 'device-local');
  const server = canonical(edit(base, 'sortKey', 'C000000000000000', T1, 'device-server'), 2, 20);
  const before = structuredClone({ base, local, server });
  const result = reconcileRecord(base, local, server, CLOCK_OPTIONS);

  assert.equal(result.action, 'upload-merged');
  assert.equal(result.record.name, 'Local name');
  assert.equal(result.record.sortKey, 'C000000000000000');
  assert.equal(result.record.version, 2);
  assert.equal(result.record.changeSeq, 20);
  assert.equal(result.expectedVersion, 2);
  assert.deepEqual(result.uploadFields, ['name']);
  assert.deepEqual({ base, local, server }, before);

  const reverse = reconcileRecord(
    base,
    edit(base, 'sortKey', '2000000000000000', T2, 'device-local'),
    canonical(edit(base, 'name', 'Server name', T1, 'device-server'), 2, 20),
    CLOCK_OPTIONS,
  );
  assert.equal(reverse.record.sortKey, '2000000000000000');
  assert.equal(reverse.record.name, 'Server name');
  assert.deepEqual(reverse.uploadFields, ['sortKey']);

  const metadataOnly = { ...cloneSyncRecord(base), version: 99, changeSeq: 999 };
  const metadataResult = reconcileRecord(base, metadataOnly, base, CLOCK_OPTIONS);
  assert.equal(metadataResult.action, 'apply-server');
  assert.equal(metadataResult.record.version, 1);
  assert.deepEqual(metadataResult.uploadFields, []);
});

test('scheduled dates are one merge field while unrelated task fields merge independently', () => {
  const base = task();
  const local = edit(base, 'scheduledDates', ['2026-09-10', '2026-09-11'], T2, 'device-local');
  const server = canonical(edit(base, 'title', 'Server title', T1, 'device-server'), 2, 20);
  const result = reconcileRecord(base, local, server, CLOCK_OPTIONS);
  assert.equal(result.action, 'upload-merged');
  assert.deepEqual(result.record.scheduledDates, ['2026-09-10', '2026-09-11']);
  assert.equal(result.record.title, 'Server title');
  assert.deepEqual(result.uploadFields, ['scheduledDates']);
});

test('same-field changes use the newest clock for equal and different values', () => {
  const base = category();
  const cases = [
    {
      name: 'same value, local clock wins',
      local: edit(base, 'name', 'Shared', T3, 'device-local'),
      server: canonical(edit(base, 'name', 'Shared', T2, 'device-server'), 2, 20),
      value: 'Shared',
      clock: clock(T3, 'device-local'),
      action: 'upload-merged',
    },
    {
      name: 'same value, server clock wins',
      local: edit(base, 'name', 'Shared', T2, 'device-local'),
      server: canonical(edit(base, 'name', 'Shared', T3, 'device-server'), 2, 20),
      value: 'Shared',
      clock: clock(T3, 'device-server'),
      action: 'apply-server',
    },
    {
      name: 'different value, local clock wins',
      local: edit(base, 'name', 'Local', T3, 'device-local'),
      server: canonical(edit(base, 'name', 'Server', T2, 'device-server'), 2, 20),
      value: 'Local',
      clock: clock(T3, 'device-local'),
      action: 'upload-merged',
    },
    {
      name: 'different value, server clock wins',
      local: edit(base, 'name', 'Local', T2, 'device-local'),
      server: canonical(edit(base, 'name', 'Server', T3, 'device-server'), 2, 20),
      value: 'Server',
      clock: clock(T3, 'device-server'),
      action: 'apply-server',
    },
  ];

  for (const item of cases) {
    const result = reconcileRecord(base, item.local, item.server, CLOCK_OPTIONS);
    assert.equal(result.record.name, item.value, item.name);
    assert.deepEqual(result.record.fieldUpdatedAt.name, item.clock, item.name);
    assert.equal(result.action, item.action, item.name);
  }

  const touchedWithoutValueChange = reconcileRecord(
    base,
    edit(base, 'name', 'Base name', T3, 'device-local'),
    canonical(edit(base, 'name', 'Base name', T2, 'device-server'), 2, 20),
    CLOCK_OPTIONS,
  );
  assert.equal(touchedWithoutValueChange.record.name, 'Base name');
  assert.deepEqual(touchedWithoutValueChange.record.fieldUpdatedAt.name, clock(T3, 'device-local'));
  assert.equal(touchedWithoutValueChange.action, 'upload-merged');
});

test('equal timestamps use device ID as a deterministic tie-breaker in both directions', () => {
  const base = category();
  const localWins = reconcileRecord(
    base,
    edit(base, 'name', 'Local', T2, 'device-z'),
    canonical(edit(base, 'name', 'Server', T2, 'device-a'), 2, 20),
    CLOCK_OPTIONS,
  );
  assert.equal(localWins.record.name, 'Local');

  const serverWins = reconcileRecord(
    base,
    edit(base, 'name', 'Local', T2, 'device-a'),
    canonical(edit(base, 'name', 'Server', T2, 'device-z'), 2, 20),
    CLOCK_OPTIONS,
  );
  assert.equal(serverWins.record.name, 'Server');
});

test('clock comparison rejects malformed and excessively future clocks', () => {
  assert.throws(
    () => compareFieldClocks(clock('not-a-time'), clock(T0), CLOCK_OPTIONS),
    /canonical ISO timestamp/,
  );
  assert.throws(
    () => compareFieldClocks(clock('2026-09-12T00:05:00.001Z'), clock(T0), CLOCK_OPTIONS),
    /too far in the future/,
  );
  assert.throws(
    () => reconcileRecord(
      category(),
      remove(category(), '2026-09-12T00:05:00.001Z', 'device-local'),
      category(),
      CLOCK_OPTIONS,
    ),
    /too far in the future/,
  );
  assert.equal(compareFieldClocks(clock(T2, 'device-a'), clock(T2, 'device-b'), CLOCK_OPTIONS), -1);
});

test('delete wins over an edit regardless of which side deletes', () => {
  const base = category();
  const localDelete = remove(base, T2, 'device-local');
  const serverEdit = canonical(edit(base, 'name', 'Server edit', T3, 'device-server'), 2, 20);
  const localResult = reconcileRecord(base, localDelete, serverEdit, CLOCK_OPTIONS);
  assert.equal(localResult.record.deletedAt, T2);
  assert.equal(localResult.record.name, 'Base name');
  assert.equal(localResult.action, 'upload-merged');

  const localEdit = edit(base, 'name', 'Local edit', T3, 'device-local');
  const serverDelete = canonical(remove(base, T2, 'device-server'), 2, 20);
  const serverResult = reconcileRecord(base, localEdit, serverDelete, CLOCK_OPTIONS);
  assert.equal(serverResult.record.deletedAt, T2);
  assert.equal(serverResult.record.name, 'Base name');
  assert.equal(serverResult.action, 'apply-server');
  assert.deepEqual(serverResult.uploadFields, []);

  const tiedLocalDelete = reconcileRecord(
    base,
    remove(base, T2, 'device-z'),
    canonical(remove(base, T2, 'device-a'), 2, 20),
    CLOCK_OPTIONS,
  );
  assert.equal(tiedLocalDelete.record.updatedByDeviceId, 'device-z');
  assert.equal(tiedLocalDelete.action, 'upload-merged');

  const tiedServerDelete = reconcileRecord(
    base,
    remove(base, T2, 'device-a'),
    canonical(remove(base, T2, 'device-z'), 2, 20),
    CLOCK_OPTIONS,
  );
  assert.equal(tiedServerDelete.record.updatedByDeviceId, 'device-z');
  assert.equal(tiedServerDelete.action, 'apply-server');
});

test('new local and new server records use insert and apply semantics', () => {
  const local = category({ version: 0, changeSeq: 0 });
  const insert = reconcileRecord(null, local, null, CLOCK_OPTIONS);
  assert.equal(insert.action, 'upload-local');
  assert.equal(insert.expectedVersion, 0);
  assert.equal(insert.base, null);

  const server = canonical(local, 1, 10);
  const fetched = reconcileRecord(null, null, server, CLOCK_OPTIONS);
  assert.equal(fetched.action, 'apply-server');
  assert.deepEqual(fetched.record, server);
  assert.deepEqual(fetched.base, server);
});

test('canonical application is idempotent and ignores older out-of-order rows', () => {
  const current = canonical(category(), 3, 30);
  assert.equal(applyServerRecord(current, cloneSyncRecord(current)), current);

  const older = canonical(category({ name: 'Older' }), 2, 20);
  assert.equal(applyServerRecord(current, older), current);

  const newer = canonical(edit(current, 'name', 'Newer', T1, 'device-server'), 4, 40);
  const applied = applyServerRecord(current, newer);
  assert.notEqual(applied, newer);
  assert.deepEqual(applied, newer);

  const first = reconcileRecord(current, current, newer, CLOCK_OPTIONS);
  const repeated = reconcileRecord(first.base, first.record, newer, CLOCK_OPTIONS);
  assert.equal(first.action, 'apply-server');
  assert.equal(repeated.action, 'noop');
  assert.deepEqual(repeated.record, first.record);
});

test('canonical rows reject contradictory version and sequence ordering', () => {
  const current = canonical(category(), 3, 30);
  assert.throws(() => applyServerRecord(current, canonical(category(), 4, 29)), /newer change sequence/);
  assert.throws(() => applyServerRecord(current, canonical(category(), 2, 31)), /older record version/);
  assert.throws(() => applyServerRecord(current, canonical(category({ name: 'Collision' }), 3, 30)), /must be identical/);
});

test('category deletion produces only active child tombstones and is idempotent', () => {
  const deletedCategory = remove(category(), T2, 'device-delete');
  const activeChild = task();
  const deletedChild = remove(task({ id: 'task-2' }), T1, 'device-old-delete');
  const otherCategory = task({ id: 'task-3', categoryId: 'category-2' });
  const cascaded = cascadeCategoryTombstones(deletedCategory, [otherCategory, deletedChild, activeChild]);
  assert.deepEqual(cascaded.map(item => item.id), ['task-1']);
  assert.equal(cascaded[0].deletedAt, T2);
  assert.equal(cascaded[0].updatedByDeviceId, 'device-delete');
  assert.deepEqual(cascadeCategoryTombstones(deletedCategory, [cascaded[0], deletedChild]), []);
  assert.deepEqual(cascadeCategoryTombstones(category(), [activeChild]), []);
});

test('sort keys are stable, ordered, and create space between neighbors', () => {
  const keys = generateEvenSortKeys(4);
  assert.equal(keys.length, 4);
  assert.deepEqual([...keys].sort(), keys);
  assert.equal(new Set(keys).size, 4);
  const middle = sortKeyBetween(keys[0], keys[1]);
  assert.ok(middle > keys[0] && middle < keys[1]);
  assert.equal(sortKeyBetween('invalid', keys[1]), null);
  assert.equal(sortKeyBetween('0000000000000000', '0000000000000001'), null);
});

test('category ordering normally changes one rank and preserves inputs', () => {
  const keys = generateEvenSortKeys(3);
  const categories = [
    category({ id: 'a', sortKey: keys[0] }),
    category({ id: 'b', sortKey: keys[1] }),
    category({ id: 'c', sortKey: keys[2] }),
  ];
  const before = structuredClone(categories);
  const assignments = reorderCategorySortKeys(categories, 'c', 'a', 'before');
  assert.equal(assignments.length, 1);
  assert.deepEqual(applyAssignments(categories, assignments).map(item => item.id), ['c', 'a', 'b']);
  assert.deepEqual(categories, before);
  assert.equal(reorderCategorySortKeys(categories, 'a', 'b', 'before'), null);
});

test('category rank moves match array insertion in both directions and positions', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const keys = generateEvenSortKeys(ids.length);
  const categories = ids.map((id, index) => category({ id, sortKey: keys[index] }));
  for (const sourceId of ids) {
    for (const targetId of ids) {
      for (const position of ['before', 'after']) {
        if (sourceId === targetId) continue;
        const expected = [...ids];
        expected.splice(expected.indexOf(sourceId), 1);
        const targetIndex = expected.indexOf(targetId);
        expected.splice(position === 'before' ? targetIndex : targetIndex + 1, 0, sourceId);
        const assignments = reorderCategorySortKeys(categories, sourceId, targetId, position);
        const actual = assignments === null
          ? ids
          : applyAssignments(categories, assignments).map(item => item.id);
        assert.deepEqual(actual, expected, `${sourceId} ${position} ${targetId}`);
      }
    }
  }
});

test('rank collisions fall back to ID order and deterministic rebalancing', () => {
  const categories = [
    category({ id: 'b', sortKey: '4000000000000000' }),
    category({ id: 'a', sortKey: '4000000000000000' }),
    category({ id: 'c', sortKey: '4000000000000001' }),
  ];
  assert.deepEqual([...categories].sort(compareBySortKeyThenId).map(item => item.id), ['a', 'b', 'c']);
  const first = reorderCategorySortKeys(categories, 'c', 'b', 'before');
  const second = reorderCategorySortKeys(categories, 'c', 'b', 'before');
  assert.deepEqual(first, second);
  assert.ok(first.length > 1);
  assert.deepEqual(applyAssignments(categories, first).map(item => item.id), ['a', 'c', 'b']);
});

test('task ordering stays inside its category and ignores tombstones', () => {
  const keys = generateEvenSortKeys(3);
  const tasks = [
    task({ id: 'a', sortKey: keys[0] }),
    task({ id: 'b', sortKey: keys[1] }),
    task({ id: 'c', sortKey: keys[2], deletedAt: T1 }),
    task({ id: 'other', categoryId: 'category-2', sortKey: keys[0] }),
  ];
  assert.equal(reorderTaskSortKeys(tasks, 'category-1', 'a', 'category-2', 'other', 'after'), null);
  assert.equal(reorderTaskSortKeys(tasks, 'category-1', 'c', 'category-1', 'a', 'before'), null);
  const assignments = reorderTaskSortKeys(tasks, 'category-1', 'a', 'category-1', 'b', 'after');
  assert.deepEqual(applyAssignments(tasks.filter(item => item.categoryId === 'category-1' && !item.deletedAt), assignments)
    .map(item => item.id), ['b', 'a']);
});
