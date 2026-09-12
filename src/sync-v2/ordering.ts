import type { CategorySyncRecord, TaskSyncRecord } from './types.ts';

export type SortPosition = 'before' | 'after';

export interface SortKeyAssignment {
  id: string;
  sortKey: string;
}

export interface RankedItem {
  id: string;
  sortKey: string;
}

const SORT_KEY_WIDTH = 16;
const SORT_KEY_MAX = (1n << 64n) - 1n;
const SORT_KEY_UPPER_BOUND = SORT_KEY_MAX + 1n;
const SORT_KEY_PATTERN = /^[0-9A-F]{16}$/;

function encodeSortKey(value: bigint): string {
  if (value < 0n || value > SORT_KEY_MAX) throw new Error('Sort-key value is outside the supported range.');
  return value.toString(16).toUpperCase().padStart(SORT_KEY_WIDTH, '0');
}

function decodeSortKey(value: string | null): bigint | null {
  if (value === null) return null;
  return SORT_KEY_PATTERN.test(value) ? BigInt(`0x${value}`) : null;
}

/** Stable display ordering; record ID resolves concurrent rank collisions. */
export function compareBySortKeyThenId(first: RankedItem, second: RankedItem): number {
  if (first.sortKey < second.sortKey) return -1;
  if (first.sortKey > second.sortKey) return 1;
  if (first.id < second.id) return -1;
  if (first.id > second.id) return 1;
  return 0;
}

export function generateEvenSortKeys(count: number): string[] {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Sort-key count must be a nonnegative safe integer.');
  if (count === 0) return [];
  const divisor = BigInt(count) + 1n;
  return Array.from({ length: count }, (_, index) => (
    encodeSortKey((SORT_KEY_UPPER_BOUND * BigInt(index + 1)) / divisor)
  ));
}

/** Returns null when the available rank space must be rebalanced. */
export function sortKeyBetween(previous: string | null, next: string | null): string | null {
  const previousValue = previous === null ? -1n : decodeSortKey(previous);
  const nextValue = next === null ? SORT_KEY_UPPER_BOUND : decodeSortKey(next);
  if (previousValue === null || nextValue === null || previousValue >= nextValue - 1n) return null;
  return encodeSortKey((previousValue + nextValue) / 2n);
}

function sortedActive<Item extends RankedItem & { deletedAt: string | null }>(items: readonly Item[]): Item[] {
  return items.filter(item => item.deletedAt === null).sort(compareBySortKeyThenId);
}

function reorderAssignments<Item extends RankedItem>(
  ordered: readonly Item[],
  sourceId: string,
  targetId: string,
  position: SortPosition,
): SortKeyAssignment[] | null {
  if (sourceId === targetId) return null;
  if (new Set(ordered.map(item => item.id)).size !== ordered.length) {
    throw new Error('Cannot rank records with duplicate IDs in one ordering scope.');
  }
  const sourceIndex = ordered.findIndex(item => item.id === sourceId);
  const targetIndex = ordered.findIndex(item => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return null;

  const desired = [...ordered];
  const [source] = desired.splice(sourceIndex, 1);
  const adjustedTarget = desired.findIndex(item => item.id === targetId);
  const insertionIndex = position === 'before' ? adjustedTarget : adjustedTarget + 1;
  desired.splice(insertionIndex, 0, source);
  if (desired.every((item, index) => item.id === ordered[index].id)) return null;

  const newIndex = desired.findIndex(item => item.id === sourceId);
  const candidate = sortKeyBetween(
    newIndex === 0 ? null : desired[newIndex - 1].sortKey,
    newIndex === desired.length - 1 ? null : desired[newIndex + 1].sortKey,
  );
  if (candidate !== null) return [{ id: sourceId, sortKey: candidate }];

  const rebalanced = generateEvenSortKeys(desired.length);
  return desired
    .map((item, index) => ({ id: item.id, sortKey: rebalanced[index] }))
    .filter(assignment => ordered.find(item => item.id === assignment.id)?.sortKey !== assignment.sortKey);
}

export function reorderCategorySortKeys(
  categories: readonly CategorySyncRecord[],
  sourceCategoryId: string,
  targetCategoryId: string,
  position: SortPosition,
): SortKeyAssignment[] | null {
  return reorderAssignments(sortedActive(categories), sourceCategoryId, targetCategoryId, position);
}

export function reorderTaskSortKeys(
  tasks: readonly TaskSyncRecord[],
  sourceCategoryId: string,
  sourceTaskId: string,
  targetCategoryId: string,
  targetTaskId: string,
  position: SortPosition,
): SortKeyAssignment[] | null {
  if (sourceCategoryId !== targetCategoryId) return null;
  const scoped = sortedActive(tasks.filter(task => task.categoryId === sourceCategoryId));
  return reorderAssignments(scoped, sourceTaskId, targetTaskId, position);
}
