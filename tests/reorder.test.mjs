import test from 'node:test';
import assert from 'node:assert/strict';
import { reorderById, reorderCategories, reorderTasksWithinCategory } from '../src/reorder.ts';

const categories = [
  { id: 'a', name: 'A', tasks: [{ id: 'a1', title: 'A1' }, { id: 'a2', title: 'A2' }, { id: 'a3', title: 'A3' }] },
  { id: 'b', name: 'B', tasks: [{ id: 'b1', title: 'B1' }] },
  { id: 'c', name: 'C', tasks: [] },
];

function ids(items) {
  return items.map(item => item.id);
}

test('categories reorder before and after targets in either direction', () => {
  assert.deepEqual(ids(reorderCategories(categories, 'c', 'a', 'before')), ['c', 'a', 'b']);
  assert.deepEqual(ids(reorderCategories(categories, 'a', 'c', 'after')), ['b', 'c', 'a']);
  assert.deepEqual(ids(reorderCategories(categories, 'a', 'c', 'before')), ['b', 'a', 'c']);
});

test('tasks reorder only within their category', () => {
  const reordered = reorderTasksWithinCategory(categories, 'a', 'a1', 'a', 'a3', 'after');
  assert.deepEqual(ids(reordered[0].tasks), ['a2', 'a3', 'a1']);
  assert.deepEqual(ids(reordered[1].tasks), ['b1']);
});

test('task order keeps hidden items in their existing relative order', () => {
  const reordered = reorderTasksWithinCategory(categories, 'a', 'a3', 'a', 'a1', 'before');
  assert.deepEqual(ids(reordered[0].tasks), ['a3', 'a1', 'a2']);
});

test('self drops and equivalent adjacent drops are no-ops', () => {
  assert.equal(reorderById(categories, 'a', 'a', 'before'), null);
  assert.equal(reorderById(categories, 'a', 'b', 'before'), null);
  assert.equal(reorderById(categories, 'b', 'a', 'after'), null);
});

test('missing IDs are rejected', () => {
  assert.equal(reorderCategories(categories, 'missing', 'a', 'before'), null);
  assert.equal(reorderCategories(categories, 'a', 'missing', 'after'), null);
  assert.equal(reorderTasksWithinCategory(categories, 'a', 'missing', 'a', 'a1', 'before'), null);
});

test('cross-category task drops are rejected without changing either category', () => {
  const before = structuredClone(categories);
  assert.equal(reorderTasksWithinCategory(categories, 'a', 'a1', 'b', 'b1', 'before'), null);
  assert.deepEqual(categories, before);
});
