import type { Category } from './model.ts';

export type DropPosition = 'before' | 'after';

function sameOrder<T>(first: readonly T[], second: readonly T[]): boolean {
  return first.length === second.length && first.every((item, index) => item === second[index]);
}

export function reorderById<T extends { id: string }>(
  items: readonly T[],
  sourceId: string,
  targetId: string,
  position: DropPosition,
): T[] | null {
  const sourceIndex = items.findIndex(item => item.id === sourceId);
  const targetIndex = items.findIndex(item => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;

  const reordered = [...items];
  const [source] = reordered.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertionIndex = position === 'before' ? adjustedTargetIndex : adjustedTargetIndex + 1;
  reordered.splice(insertionIndex, 0, source);
  return sameOrder(items, reordered) ? null : reordered;
}

export function reorderCategories(
  categories: readonly Category[],
  sourceCategoryId: string,
  targetCategoryId: string,
  position: DropPosition,
): Category[] | null {
  return reorderById(categories, sourceCategoryId, targetCategoryId, position);
}

export function reorderTasksWithinCategory(
  categories: readonly Category[],
  sourceCategoryId: string,
  sourceTaskId: string,
  targetCategoryId: string,
  targetTaskId: string,
  position: DropPosition,
): Category[] | null {
  if (sourceCategoryId !== targetCategoryId) return null;
  const category = categories.find(item => item.id === sourceCategoryId);
  if (!category) return null;
  const tasks = reorderById(category.tasks, sourceTaskId, targetTaskId, position);
  if (!tasks) return null;
  return categories.map(item => item.id === category.id ? { ...item, tasks } : item);
}
