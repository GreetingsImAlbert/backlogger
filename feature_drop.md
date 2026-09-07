# Drag-and-Drop Prioritization Plan

## Goal

Add mouse drag-and-drop reordering for categories and tasks so their saved order represents priority.

- Categories may be reordered among other categories.
- Tasks may be reordered only inside their current category.
- A task must never be accepted by another category, even if the pointer crosses or is released over it.
- Existing editing, completion, filtering, syncing, and scroll-preservation behavior must continue to work.

## Interaction design

1. Add a dedicated grip handle to each category heading and task row. Dragging starts only from this handle so clicking a task title, checkmark, or menu still behaves normally.
2. Keep the existing **Move up** and **Move down** menu actions. They remain the keyboard-accessible and non-drag fallback.
3. While dragging:
   - Reduce the source row's opacity.
   - Show a clear insertion line before or after the valid target, based on the pointer's vertical position.
   - Use a grabbing cursor on the active handle.
   - Show no insertion marker and use a disallowed drop effect for invalid targets.
4. Dropping a category before or after another category changes the global category order.
5. Dropping a task before or after another task changes only that category's task order.
6. Cancelled or completed drags remove every temporary class and drag state.
7. Dragging is disabled whenever normal editing is disabled, such as while loading, fetching, or closing.

## Ordering behavior in filtered views

`All`, `Today`, and `Tomorrow` remain views over the same canonical arrays.

- A category dragged in a filtered view is inserted before or after the visible target in the full category array. Categories that were not visible retain their relative order.
- A task dragged in a filtered view is inserted before or after the visible target in its full category task array. Hidden tasks retain their relative order.
- This makes the resulting priority deterministic when returning to `All` without ever moving a task into a different category.

## Implementation approach

### 1. Add testable reorder utilities

Create `src/reorder.ts` with ID-based helpers rather than depending on transient DOM indexes:

- A `DropPosition` type: `before | after`.
- A generic helper that returns a reordered copy of an ID-bearing array.
- A task-specific helper that requires matching source and target category IDs and rejects cross-category moves.
- No-op and invalid moves return a clear result so the app does not create unnecessary revisions or saves.

The data schema does not change: category priority is already represented by `notebook.categories`, and task priority by each category's `tasks` array.

### 2. Track one internal drag session

Add a discriminated drag state in `src/main.ts`:

- Category drag: category ID.
- Task drag: category ID and task ID.

Use the in-memory state as the authority. Use pointer events (`pointerdown`, document-level `pointermove`, `pointerup`, and `pointercancel`) with pointer capture instead of HTML5 drag events, because the native WebView2 path does not reliably emit the latter for this handle. No cross-window payload is needed: all valid targets are in the same app window.

### 3. Wire category dragging

- Render a category grip handle in `.category-top`.
- Mark category sections with their category ID.
- Accept category drags only on category targets.
- Calculate `before` or `after` from the target section's vertical midpoint.
- On a valid drop, call `commit()` once with the reordered category array and a concise status message.

### 4. Wire task dragging with a hard category boundary

- Render a task grip handle at the start of each task row.
- Mark task rows with their task and category IDs.
- A task target calls `preventDefault()` only when the dragged task and target task have the same category ID.
- The drop handler repeats that same-category check before touching notebook data.
- Category containers and empty task lists never accept a task from another category.
- On a valid drop, call `commit()` once with only the source category's reordered task array.

This two-layer validation prevents cross-category moves even if browser drag events fire on an unexpected nested element.

### 5. Add visual states

Update `src/style.css` with styles for:

- `.drag-handle`
- `.is-dragging`
- `.drop-before`
- `.drop-after`
- Fine-pointer hover visibility consistent with the existing task action controls
- Persistent visibility on coarse-pointer devices where hover is unavailable

Drop markers should not change row height, which avoids list movement while choosing a position.

### 6. Preserve current app behavior

- Route successful drops through the existing `commit()` path so local saves, sync snapshots, session dirty state, and scroll preservation all remain centralized.
- Do not commit when the source and final position are unchanged.
- Close any open action menu when a drag begins.
- Keep task completion available only for tasks scheduled today.
- Keep category/task editing and deletion behavior unchanged.

## Tests

Add `tests/reorder.test.mjs` covering:

- Category moves forward and backward using before/after targets.
- Task moves forward and backward within one category.
- Dropping onto itself is a no-op.
- Dropping into the immediately equivalent position is a no-op.
- Missing source or target IDs are rejected.
- A task move with different source and target category IDs is rejected and leaves both categories unchanged.
- Hidden-item ordering remains stable when moving relative to visible targets.

Then run:

1. `npm run check`
2. `npm test`
3. `npm run build`
4. `npm run tauri build`

## Manual verification checklist

- Drag categories upward and downward and confirm the order persists after reopening the app.
- Drag tasks upward and downward within a category and confirm persistence.
- Try dragging a task onto another category's heading and task rows; no drop marker or data change should occur.
- Verify reordering from `Today` and `Tomorrow`, then switch to `All` and confirm deterministic full-list order.
- Confirm the page does not jump to the bottom after a drop.
- Confirm task title editing, today's checkmark, hamburger menus, Move up/down, and keyboard focus still work.
- Confirm all drag styling clears after a completed or cancelled drag.

## Acceptance criteria

- Categories can be prioritized by drag-and-drop.
- Tasks can be prioritized by drag-and-drop only within their original category.
- Cross-category task drops are impossible at both the event and data-mutation layers.
- Reordered data saves and syncs through the existing persistence path.
- Existing Move up/down actions remain available.
- No schema migration or new runtime dependency is introduced.
- Automated checks and the Tauri desktop build pass.
