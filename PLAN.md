# Backlogger — implementation plan

Status: implementation in progress. The plan remains the product and reliability baseline; completed work and verification are tracked in PROGRESS.md.

## 1. Purpose

Build a small desktop task list that feels like the current OneNote Sticky Notes workflow:

- Group tasks under courses or custom categories.
- Give each task any number of planned work dates and an optional deadline.
- Show compact date annotations beside each task.
- Automatically underline tasks scheduled for today.
- Keep task creation and deletion manual.
- Save everything locally without an account, server, or cloud database.

The app should open directly to the list. Avoid dashboards, productivity scores, project-management terminology, and unnecessary navigation.

## 2. Interpretation of the current notation

Proposed weekday mapping, to confirm before implementation:

| Code | Day |
| --- | --- |
| M | Monday |
| T | Tuesday |
| W | Wednesday |
| H | Thursday |
| F | Friday |
| A | Saturday |
| S | Sunday |

Square brackets describe when to work on a task. Parentheses describe when it is due. These are independent: a Friday deadline does not automatically schedule Friday work.

Examples:

- `Read Lennard Davis [H,F,A,S]`: work on four selected dates; no deadline.
- `Think of AI Box Assumptions [F] (F)`: work Friday and submit Friday.
- `Meeting 4 (M)`: Monday deadline; no planned work date.
- `Presentation 3 [M] (W)`: work Monday; due Wednesday.

### Resolve weekday ambiguity with actual dates

Store full calendar dates internally rather than weekday letters alone. A task planned for Monday must not silently become a recurring task every Monday.

- The editor opens to the current week and permits selecting dates in later weeks.
- Show the selected week's date range so that choosing a past or future Monday is explicit.
- For dates in the current week, use the familiar compact letters in the list.
- For dates outside the current week, include the month and day, such as `[M Sep 14]`, to prevent ambiguity.
- A tooltip or accessible label always exposes the full date.
- Do not move scheduled dates forward automatically when a new week starts.
- Treat deadlines as date-only values in the first version; no due times.

## 3. Main screen

One compact, resizable window with a vertically scrolling list:

```text
Backlogger                      Today: Mon, Sep 7

Eng 13                                      +
  Read Lennard Davis [H,F,A,S]
  Read relevant articles and take notes [S]
  Start Tiger Technology [M]                 ← underlined today

Engg 150                                    +
  Think of AI Box Assumptions [F] (F)

Philo 1                                     +

ME 195                                      +
  Lean Canvas [M,T,W,H,F] (F)                 ← underlined today

+ Add category
```

This is an illustrative layout, not a dated import of the existing backlog.

- Preserve category and task order between launches.
- Keep empty categories visible so the user's course list remains useful.
- Allow category creation, renaming, reordering, and deletion.
- Allow task creation, editing, moving between categories, reordering, and deletion.
- Show task actions on hover or keyboard focus to keep the default view quiet.
- Provide a small `All / Today` view switch. Default to All, which preserves the existing overview.
- Today shows tasks explicitly scheduled for today's date; it does not pull in unscheduled tasks merely because they are due.
- Use readable text, compact spacing, and restrained visual styling.
- Optional always-on-top behavior can follow the initial working version.

## 4. Adding and editing tasks

Use one small inline editor or popover containing:

1. Task title.
2. Planned work dates: a calendar supporting multiple date selections.
3. Optional deadline: a separate single-date picker.
4. Save and Cancel controls.

The app generates bracket and parenthesis annotations automatically. Users should not need to type or maintain the notation.

- Enter saves a valid title; Escape cancels editing.
- A title is required; dates are optional.
- Duplicate titles are allowed because separate assignments can share a name.
- Planned work dates are sorted and deduplicated.
- Work dates after the deadline are allowed, with a small informational cue rather than a blocking rule.
- Opening an existing task uses the same editor.
- Typing the original bracket notation and bulk pasting Sticky Notes content are later conveniences, not dependencies for the first version.

## 5. Automatic behavior

### Today's work

- Underline the task title when today's local calendar date appears in its planned work dates.
- Provide an accessible `Scheduled today` label; color must not be the only signal.
- Recalculate on launch, at local midnight, and when the window resumes or regains focus.
- Refresh after system date or time-zone changes. Calendar dates remain the dates the user selected.
- Do not save a separate `isToday` flag; derive it from dates.

### Deadlines and missed work

- Mark a deadline due today with a small `Due today` indicator.
- Mark a deadline before today as overdue, while preserving the original date.
- A past work date stops triggering today's underline. It remains visible in the task's schedule.
- Do not assume that a past work date means work was missed: the app has no per-day completion tracking.
- Never reschedule or delete tasks automatically.

### Finishing work

Retain the user's existing model: finishing a task means manually deleting it. Do not introduce checkboxes, automatic completion, or an archive in the initial version.

- Task deletion takes effect immediately with a short-lived Undo action.
- Deleting a category containing tasks requires confirmation with the task count, followed by an Undo opportunity.
- An empty category can be deleted directly.

## 6. Desktop implementation approach

Proposed stack: Tauri with a TypeScript interface and plain CSS. Keep the interface simple enough that a frontend framework is unnecessary initially.

The intended first target is Windows, matching the current workspace. Keep storage and date logic independent of the interface so other desktop platforms can be added later. Mobile apps and browser access are outside the first release.

Before implementation, inspect the repository and any project instructions. Reuse an existing suitable application structure rather than replacing it. Confirm desktop tooling and packaging prerequisites at that time; none have been checked during this planning step.

Responsibilities:

- Interface: render categories, edit tasks, display date annotations, and support keyboard interaction.
- Domain logic: validate records, calculate today's state, format dates, and manage ordering.
- Desktop layer: read and write app data, manage backups, and handle file dialogs.

No hosted backend, telemetry, account system, or internet connection is required for core operation.

## 7. Local data and reliability

Use one versioned JSON document in the operating system's per-user application-data directory. For this scale, a database is unnecessary.

| Record | Fields |
| --- | --- |
| Document | schemaVersion, revision, categories, tasks, preferences |
| Category | id, name, order |
| Task | id, categoryId, title, scheduledDates, deadlineDate, order, createdAt, updatedAt |
| Preferences | window bounds, selected view, appearance settings when introduced |

- IDs are stable and independent of titles or category names.
- Scheduled dates and deadlines use `YYYY-MM-DD` calendar strings, with no UTC conversion.
- Creation and update timestamps use UTC instants.
- Changes save automatically after committed edits, including deletion and reordering.
- Serialize writes to prevent an older save from overwriting a newer one.
- Write to a temporary file in the same directory, then replace the main file using an appropriate atomic replacement strategy.
- Keep a last-known-good backup and a bounded set of recovery snapshots.
- Validate data on load. Preserve an unreadable file and offer recovery from a backup; never silently replace it with an empty list.
- Display a persistent save error with Retry when storage is unavailable. Keep the unsaved state available while the app remains open.
- Use a single application instance to avoid concurrent local writers.
- Provide Export and Import with schema validation. The initial import replaces the list only after a preview and confirmation, and first creates a backup.
- Validate relationships and date values during import, and handle future schema versions without destructive downgrades.

## 8. Optional syncing without a cloud database

Ship reliable local storage first. Sync should be optional and should not change the offline editing experience.

### First release: portable backups

Export a file on one device and import it on another. This is manual transfer, not automatic sync, but provides an immediate way to move the backlog and recover data.

### Later release: synchronize through a user-managed folder

Allow the app to exchange records through a folder that the user synchronizes between devices with a local file-sync tool, or a reachable network folder. A local-only configuration must not require cloud storage. External file transfer remains a separately configured capability; choosing a folder does not itself connect devices.

Keep the app's primary data local. Do not let several devices overwrite the same live JSON file.

Proposed exchange design:

- Each device writes uniquely identified, immutable change records to the exchange folder.
- Records include device ID, change ID, affected record ID, and the revision on which the edit was based.
- Import changes idempotently so repeated discovery cannot duplicate tasks.
- Merge independent edits automatically.
- Keep deletions as tombstones so an offline device cannot resurrect deleted tasks.
- Surface simultaneous edits to the same field, or an edit concurrent with deletion, for a small user-visible conflict resolution flow.
- Do not use wall-clock timestamps alone to choose a winner; device clocks can disagree.
- Handle partial files and an unavailable exchange folder without interrupting local use.
- Defer compaction until an acknowledgement strategy makes deletion history safe to discard.

This phase needs a separate implementation design and testing across actual devices. Phone access would additionally require a compatible client and storage integration; desktop file sync alone does not provide a mobile app.

## 9. Scope boundaries

First release includes categories, manual task management, multiple planned dates, optional deadlines, automatic daily underlining, a Today filter, local autosave, recovery, import/export, and a Windows installer.

Deferred features: automatic sync, recurring tasks, notification reminders, deadline times, rich text, attachments, calendar integration, mobile clients, completion history, bulk notation import, and advanced themes.

## 10. Implementation sequence

1. Inspect the repository, project instructions, and available desktop tooling. Confirm weekday mapping and the calendar-date interpretation.
2. Establish the desktop shell and a compact list using temporary sample data.
3. Implement categories, task editing, date selection, ordering, deletion, and Undo.
4. Implement derived date annotations, today's underline, deadline indicators, and the Today filter.
5. Add local persistence, validation, backups, recovery, and import/export.
6. Verify keyboard access, window resizing, long titles, and behavior after restart and sleep.
7. Package and manually exercise the Windows app with the user's sample categories and tasks after assigning explicit dates.
8. Consider optional folder-based sync after the local version is satisfactory.

## 11. Acceptance checks

- The provided backlog can be represented, including empty categories and tasks with no dates.
- Selecting several work dates produces the appropriate bracket annotation automatically.
- Deadlines produce independent parenthesis annotations.
- On a selected work date, the task is underlined without manual changes.
- A deadline alone does not cause a task to be treated as scheduled work.
- Today's state updates after midnight and after the computer wakes from sleep.
- A task scheduled last Monday does not become scheduled again next Monday.
- Dates remain correct across month/year boundaries and time-zone changes.
- Tasks remain present until explicitly deleted; deletion can be undone.
- Category names, task order, and edits survive closing and reopening the app.
- An interrupted or failed save does not silently erase the backlog.
- An invalid import leaves the current backlog intact.
- Exported data can be imported into a fresh installation.
- Core functionality works with the network disconnected.

Use focused tests for date calculations, persistence recovery, and import validation, plus a manual desktop smoke test of the complete workflow. Record idle memory, startup time, and installer size on the actual build before making performance claims.

## 12. Decisions to confirm before coding

Defaults used in this proposal:

- Windows first.
- `H` means Thursday, `A` means Saturday, and `S` means Sunday.
- Weekday selections represent specific dates, not automatic weekly recurrence.
- All categories remain visible by default; today's tasks are underlined in place.
- Deletion remains the way to finish a task.
- Local storage is required; automatic device sync is a later optional phase.

These defaults allow a concrete first version without expanding the user's current workflow unnecessarily.
