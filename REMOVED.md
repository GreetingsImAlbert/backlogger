# Retired planning archive

This file preserves durable information from the removed `PLAN.md`, `PROGRESS.md`, `feature.md`, `feature_drop.md`, and `FEATURES.md`. It is historical context, not the active mobile implementation plan.

## Product contract

- Backlogger is a compact, offline-first category and task list. Core use does not require an account, hosted backend, telemetry, or network connection.
- Tasks have a required title, zero or more concrete scheduled dates, and an optional independent deadline. Dates are stored as `YYYY-MM-DD` without UTC conversion and never recur automatically.
- Compact weekday notation is `M` Monday, `T` Tuesday, `W` Wednesday, `H` Thursday, `F` Friday, `A` Saturday, and `S` Sunday. Dates outside the current week include month/day, and another year includes the year.
- A task is underlined only when today is one of its scheduled dates. A deadline alone does not put it in Today. Due-today and overdue states are derived rather than stored.
- Categories remain visible even when empty. Category/task order is canonical and persists. Finishing work means manually deleting it; deletion has a short Undo rather than completion history or an archive.
- Categories and tasks support add, edit, delete, reorder, and task movement between categories. Pointer drag prioritization uses dedicated handles; task drops are rejected across categories at both UI and data layers. Move up/down remains available for keyboard use.

## Local-data behavior

- The versioned notebook contains stable category/task IDs, revision, categories, tasks, and local preferences. Scheduled dates are sorted and deduplicated; malformed dates, unsupported versions, broken relationships, and duplicate IDs are rejected.
- Committed edits save serially to local app data. Native writes use a same-directory temporary file, flush before replacement, and retain a last-known-good backup. Invalid primary data is preserved and recovery is explicit.
- Import validates and previews content before replacement and creates a recoverable backup. Portable export excludes device identity, sync location/state, credentials, pending publications, and ignored-update state.
- Windows uses native file dialogs and a single-instance guard. Browser preview uses local storage and browser file APIs as development fallbacks.

## Desktop sync design and safety history

- Desktop folder sync is experimental until a real provider-backed two-device acceptance pass succeeds. A successful local filesystem write does not prove OneDrive uploaded or delivered it.
- The primary notebook remains device-local. The exchange layout is `backlogger-sync/notebook.json` plus immutable `backlogger-sync/snapshots/<snapshot-id>.json` records. Snapshots carry notebook/device/snapshot IDs, parent IDs, and complete category/task data; shared snapshots exclude theme and view.
- The current desktop model saves locally after edits, checks shared history on startup/focus and roughly every 15 seconds, presents Fetch/Ignore for delivered updates, and normally publishes one pending snapshot on close. Pause stops folder activity but not local saves; disconnect leaves shared files untouched.
- Reconciliation uses validated ancestry and common bases, never file times or per-device revisions. Independent changes may merge; same-field, delete/edit, category-content, move, or ordering conflicts remain durable until explicitly resolved. Resolutions reference both branches.
- Startup fetch is bounded and read-only while checking. Missing folders/files, incomplete ancestry, invalid JSON, offline providers, and timeouts preserve local content and offer retry/offline behavior. Active drafts and unpublished edits require explicit replacement decisions.
- Retention targets 30 completed recovery snapshots only for a validated unbranched history. A self-contained checkpoint and manifest metadata must be confirmed before pruning. Heads, conflicts, pending work, branches, and required ancestry remain protected even above the target.
- A 2026-09-07 stale-data incident showed that a lower-revision snapshot could incorrectly name newer snapshots as parents. The parser now rejects a child revision older than a known parent, reconciles remote history before publishing pending work, and preserves recovery branches. Never weaken this validation.
- Windows chooses the OneDrive parent directory and appends `backlogger-sync`; Android will access the existing `/backlogger-sync` item through Microsoft Graph. Live provider tests must prevent `backlogger-sync/backlogger-sync` and use the isolated `/backlogger-sync-test` folder before any production writes.

## Last verified checkpoint

- Windows includes local editing, date behavior, dark/light themes, Undo, native import/export, backups/recovery, pointer reordering, session-based folder sync, three-way merge/conflicts, close-time publication, and checkpoint retention.
- Android Milestones 1–2 are implemented: shared Tauri mobile entry point, native app-data persistence, mobile capability gating, safe-area/touch layout, typed transport boundary, Windows local-folder adapter, sync-state migration, and an x86_64 debug APK. OneDrive/MSAL and Android content-URI import/export are not yet implemented.
- The latest recorded checks passed TypeScript validation, all 27 tests, frontend build, Rust formatting/checks, the Windows NSIS build, and the Android debug build. Emulator smoke testing confirmed local persistence after force-stop, themes, portrait/landscape layouts, and disabled unfinished actions.
- Android package/activity: `local.backlogger.desktop/.MainActivity`. Debug APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
- Windows installer output: `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`. It is an unsigned local release candidate.

## Outstanding release checks and deferred ideas

- Before calling sync release-ready: complete isolated Graph tests, read-only live validation, controlled two-way Windows/Android OneDrive acceptance, offline/divergence/conflict recovery, delayed delivery, and retention stress testing.
- A signed Android release needs a final owned package identifier decision, release keystore kept outside the repository, matching Entra certificate configuration, ARM release targets, and physical-phone accessibility/touch testing.
- Always-on-top remains a deferred desktop idea. Google Drive, other providers, iOS, recurring tasks, notifications, rich text, attachments, calendar integration, and completion history are outside the current Android/OneDrive scope.
