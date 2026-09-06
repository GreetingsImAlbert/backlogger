# Implementation progress

Current checkpoint: session-based folder sync (startup fetch lock, local autosave, close-time publication, delayed-update notices, and versioned 30-snapshot checkpoint retention) is implemented and built. Real provider-backed two-device acceptance remains before release.

## 2026-09-06 — Minimal interface and dark mode

- Replaced the green notebook styling with neutral charcoal and white palettes, rounded controls, and restrained typography inspired by the ChatGPT app.
- Removed decorative introductory copy, routine storage banners, repeated scheduled/due badges, empty-category messages, and sample-loading prompts.
- Kept today's underline and compact schedule/deadline notation. Overdue deadlines retain a visible `!` plus an accessible full-date label.
- Moved reorder/rename/delete controls into keyboard-accessible category/task menus. Import and Export are in the top-right menu. Task titles still open the editor directly.
- Added persistent dark/light mode, defaulting to dark for existing documents without a theme preference. Added native window theme synchronization.
- Applied both themes to dialogs, calendar selections, inputs, focus states, and menus. Clear deadline appears only when a deadline is set. Save errors and recovery/retry actions remain visible when needed.
- Verified dark and light screenshots, theme persistence on reopening, category menu editing/cancel, task editor date selection/cancel, and no browser console errors.
- All 10 tests pass, including legacy-document compatibility and light-theme round-trip validation. Frontend type-check and production build pass.
- `npm.cmd run tauri -- build` passed, compiling the native theme command and rebuilding `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe` with the redesigned interface. Prior release sizes and hashes below refer to the earlier build. Native title-bar colors were compiled but not visually inspected in this checkpoint.

## Milestones

| Milestone | Deliverable and exit criteria | Status |
| --- | --- | --- |
| 1 — Foundation | TypeScript list preview, Tauri shell configuration, build check, and setup instructions. Native launch verified once prerequisites are available. | Complete |
| 2 — Manual task management | Add/edit/delete categories and tasks, date picker, ordering, moving tasks, and Undo; verify the editing workflow in memory. | Complete in memory; persistence is milestone 4 |
| 3 — Daily behavior | Date notation, automatic today underline, deadline indicators, Today filter, midnight/resume refresh; test calendar boundaries. | Complete for this checkpoint; manual midnight transition remains a release smoke check |
| 4 — Durable local data | Autosave, validation, recovery backups, single instance, import/export; test failure recovery and restart. | Complete for this checkpoint |
| 5 — Desktop release | Keyboard/layout review, native smoke test, Windows installer, measured startup and memory. | Release candidate; signing deferred |
| 6 — Optional device sync | Separate design review and local-folder exchange implementation if requested. | Deferred |

## Working agreement

- Complete one reasonable milestone or checkpoint per work session, then report results.
- Keep this file current with changes, verification, blockers, and the next action.
- Follow PLAN.md defaults accepted when implementation was authorized.
- Do not present sample data as imported, saved user data.

## 2026-09-06 — Milestone 1

### Inspection

- Repository folder initially contains only PLAN.md; no existing application, Git repository, or applicable AGENTS.md found in inspected workspace/ancestor paths.
- Node.js 24.18.0 and npm 11.16.0 are available.
- Rust/Cargo are absent from PATH and Cargo is absent from the default user installation path.
- Tauri diagnostics confirm MSVC Build Tools 2026 and WebView2 152.0.4191.66 are installed.

### Scope of this checkpoint

- Scaffold plain TypeScript/CSS with Vite and a minimal Tauri desktop host.
- Render the supplied sample categories and task notation in a compact, responsive list.
- Keep preview read-only; editing and storage belong to subsequent milestones.
- Verify the frontend build and inspect the preview. Record native tooling limitations explicitly.

### Implemented

- Vite 8.2.2, TypeScript 7.0.2, and Tauri CLI 2.11.4 scaffolding with npm lockfile.
- Compact read-only list containing all nine supplied categories and 12 tasks, including empty categories, work-day brackets, and deadline parentheses.
- Explicit sample-data notice; no fake edit controls or persistence claims.
- Semantic category headings and lists; wrapping task titles and a narrow-screen CSS breakpoint.
- Minimal Rust desktop entry point and 520 × 800 resizable window configuration.
- Local SVG application icon and generated native icon assets.
- README with preview, build, and desktop setup instructions; generated/build directories ignored.

### Verification

- `npm.cmd install`: succeeded; audit reported zero vulnerabilities.
- Initial type-check found missing CSS import declarations; added Vite client types.
- `npm.cmd run build`: passed TypeScript checking and production bundling after that fix.
- Production output: approximately 2.85 kB JavaScript and 1.44 kB CSS before gzip, excluding native host and runtime. These are asset sizes, not installed app size or memory measurements.
- `npm.cmd run tauri -- icon src-tauri/app-icon.svg`: succeeded.
- `npm.cmd run tauri -- info`: configuration recognized; confirmed Rust, Cargo, and rustup are missing. Native compilation/launch remains unverified.
- Opened the preview at http://127.0.0.1:1420 in the in-app browser; inspected its accessibility tree and screenshot. All nine categories and 12 task titles are present, with no visible clipping in the inspected viewport.
- Native resizing, narrow-window visual checks, and application runtime checks remain pending.
- No automated tests added for this static layout checkpoint; date and storage tests will accompany those implementations.

### Next action

Milestone 1 was closed after the user installed Rust. Milestone 2 and the date-behavior checkpoint are now recorded below. The next increment is durable local storage.

## 2026-09-06 — Rust verification and milestone 2a

- Confirmed Rust 1.98.1 and Cargo 1.98.1 via the user's default Rust installation. The running shell adds the Cargo bin directory to its process PATH; no system settings changed.
- Native Tauri development build completed and launched the Backlogger window. WebView2 152.0.4191.66 and MSVC Build Tools 2026 are available.
- Added date-only domain helpers and validation for impossible dates, leap days, year boundaries, DST changes, sorted/deduplicated selections, and Monday-based weeks.
- Added in-memory category and task creation, editing, deletion, deletion confirmation, 15-second Undo, and explicit sample backlog loading.
- Added multiple concrete work-date selection, independent deadline selection, after-deadline advisory, week navigation, and clear deadline.
- Added category up/down controls, task up/down controls, and a category selector for moving existing tasks.
- Repaired Vite development watching to ignore `src-tauri`, avoiding Windows file-lock failures while Rust output is built.
- Browser smoke-tested category creation/reorder, task creation/reorder, task movement, task deletion/Undo, category deletion confirmation/Undo, edit cancellation, validation, date selection, deadline clearing, and the 340px minimum-width editor.
- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 4 date/calendar tests.
- `npm.cmd run build`: passed; output is approximately 10.43 kB JavaScript and 4.47 kB CSS before gzip for this checkpoint.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed after the reorder changes (`Finished dev profile`).

## 2026-09-06 — Milestone 3

- Added date-derived compact notation: current-week dates display as `M,T,W,H,F,A,S`; dates outside the current week include the weekday plus month/day, and dates in another year include the year.
- Added derived `Scheduled today` state and title underlining with an accessible label. The state is never stored separately.
- Added `Due today` and `Overdue` text indicators while keeping the original deadline annotation visible.
- Added `All` and `Today · <date>` views. Today includes only tasks whose planned work dates contain the local current date; deadline-only tasks remain out of the view.
- Added date-state refresh on a 30-second interval, window focus, and visibility resume so midnight and wake-up updates do not require a manual edit.
- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 5 date/calendar tests, including compact notation across week and year boundaries.
- `npm.cmd run build`: passed; output is approximately 12.06 kB JavaScript and 5.09 kB CSS before gzip for this checkpoint.
- Fresh browser smoke test loaded the opt-in sample backlog, confirmed two Sunday tasks were marked `Scheduled today`, confirmed past deadlines showed `Overdue`, and confirmed Today view excluded every task without today's planned date.
- The editor still fits the configured 340px minimum width; prior browser console inspection had no warnings or errors.

### Next action

The next increment is visible recovery controls, import/export, and the single-instance guard on top of the completed autosave core.

## 2026-09-06 — Milestone 4a

### Implemented

- Added a versioned storage document with schema validation, revision numbers, stable category/task IDs, date normalization, duplicate-ID checks, and view preference persistence.
- Added serialized autosaves after every committed edit, reorder, deletion, Undo, and view change. New saves cannot overtake an earlier write.
- Added browser-preview fallback storage through `localStorage`, keeping the preview useful without a native host.
- Added Tauri `load_notebook` and `save_notebook` commands. Desktop data is stored in the per-user app-data directory as `backlogger.json`; the previous valid file is retained as `backlogger.json.bak` before replacement.
- Added temporary-file writes with `sync_all()` before replacement and JSON syntax validation at the native boundary.
- Added a persistent storage notice and unsaved-change protection while a save is pending or has failed.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 7 tests, including storage normalization and invalid-document rejection.
- `npm.cmd run build`: passed; output is approximately 15.89 kB JavaScript and 5.09 kB CSS before gzip for this checkpoint.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed after adding the storage commands and durable temporary-file write path.
- Browser smoke test created a category and task, observed `Saved locally`, opened a second preview tab, and confirmed both records were restored from browser local storage with no console errors.

### Known limitation

- The browser smoke test leaves its temporary `Storage check` category and `Persists after reload` task in that preview origin so the persistence result remains inspectable. They can be removed through the app's normal deletion flow.
- Import/export, backup recovery UI, and single-instance enforcement remain in the next increment.

### Next action

Run a two-launch native smoke test, then move to desktop release checks and installer packaging.

## 2026-09-06 — Milestone 4b

### Implemented

- Added JSON export using the validated, versioned document format.
- Added JSON import through the native file picker/browser file chooser. Imported content is parsed, schema-validated, summarized, and confirmed before replacing the current list.
- Import replacement supports the existing 15-second Undo flow and preserves the imported view preference.
- Added explicit backup recovery when saved data cannot be validated. The user must choose `Recover backup`; the app does not silently replace the current list.
- Added browser backup retention for the previous valid local document and a Tauri command for reading `backlogger.json.bak`.
- Kept unreadable primary data intact during browser recovery writes and native saves.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 9 tests, including malformed import rejection and browser backup retention.
- `npm.cmd run build`: passed; output is approximately 18.38 kB JavaScript and 5.24 kB CSS before gzip for this checkpoint.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with the backup-recovery command registered.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- Browser smoke test confirmed the new Export JSON and Import JSON controls, successful JSON export status, and no console errors.

### Known limitation

- The browser preview still contains the temporary `Storage check` category and `Persists after reload` task from the persistence smoke test. They can be removed through the app's normal deletion flow.

## 2026-09-06 — Milestone 4c

### Implemented

- Added an explicit `Retry save` action that retries the current in-memory document after a transient local write failure without requiring another edit.
- Added Tauri's single-instance plugin for Windows, macOS, and Linux desktop targets. A second launch focuses the existing main window instead of creating a concurrent writer.
- Kept the browser preview multi-tab behavior unchanged; the native single-instance guard applies to the desktop host.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 9 tests.
- `npm.cmd run build`: passed; output is approximately 18.47 kB JavaScript and 5.24 kB CSS before gzip for this checkpoint.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with `tauri-plugin-single-instance` 2.4.4.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- Fresh browser smoke test confirmed the persisted local data and storage controls still load without console errors.

### Known limitation

- Native two-launch focus behavior was tested against the release executable in the next desktop checkpoint; a window-level focus inspection remains a manual follow-up if needed.

## 2026-09-06 — Milestone 5a

### Implemented

- Enabled Windows NSIS bundling in `src-tauri/tauri.conf.json`.
- Built the optimized native executable and Windows installer.
- Kept the app's minimum window size at 340 × 420 and preserved keyboard-focus outlines and dialog keyboard behavior for the release candidate.

### Verification

- `npm.cmd run tauri -- build`: passed.
- Native release executable: `src-tauri/target/release/backlogger.exe`, 8,282,112 bytes.
- NSIS installer: `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`, 1,811,240 bytes.
- Two-launch smoke test: the first release process remained responsive, the second launch exited, and exactly one Backlogger process remained. The test process was then closed.
- The browser preview still loads the persisted test data and exposes the storage controls without console errors.

### Next action

Decide whether a signed installer is needed for distribution; signing requires a certificate and release identity that are not present in this workspace.

## 2026-09-06 — Milestone 5b

### Verification

- Native release startup reached a responsive `Backlogger` window in approximately 201 ms on this machine.
- After five idle seconds, the release process reported 22,306,816 bytes of working-set memory and 5,222,400 bytes of private memory. These are one local observation, not a performance guarantee.
- The native window accepted a 340 × 420 outer-size request and remained responsive, matching the configured minimum dimensions.
- The NSIS installer is present at `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe` and is 1,811,240 bytes.
- The installer is currently unsigned (`NotSigned`). SHA-256: `8B7D3F05D324C63D977C40616E1A6951FE00C9BA3B23C443B20C5A67FD7213EC`.

### Release decision

- Keep signing deferred for this local release candidate. A production distribution can add Authenticode signing once a certificate and publisher identity are available.

## 2026-09-06 — Cloud-folder sync milestone 1

### Implemented

- Repaired desktop Export so it opens a native Save dialog and writes the validated versioned document to the selected JSON path. Cancelling the dialog leaves the notebook unchanged.
- Repaired desktop Import so it opens a native Open dialog, reads the selected file through the Tauri host, validates and previews it, and only replaces the current list after confirmation. The existing backup and Undo paths still apply to the replacement.
- Kept browser-preview Import/Export behavior as a development fallback; the browser export remains a download and browser import remains a file chooser.
- Added a native JSON file read/write boundary and the Tauri dialog capability required by the desktop UI.
- Changed native replacement to flush the temporary file and use a replacement move on Windows, preserving the last valid app-data backup before local saves. This avoids deleting the primary file before the replacement succeeds.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 10 tests.
- `npm.cmd run build`: passed; output is approximately 20.21 kB JavaScript and 6.47 kB CSS before gzip for this checkpoint.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with the Windows replacement dependency and dialog plugin.
- `npm.cmd run tauri -- build`: passed; rebuilt `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`.
- Rebuilt installer size: 1,950,558 bytes. SHA-256: `3B3646FEC7D9C6A8370498992ADE1DF5FEEF7C0FB452D5FE100B724083378CA1`. Authenticode status: `NotSigned`.
- Native dialog round-trip and cancellation still require a manual desktop smoke test because the browser preview cannot open native Windows dialogs.

### Boundary

This milestone repairs the local/native file foundation only. It does not connect a cloud folder, publish snapshots, fetch remote changes, or reconcile two devices. Those begin in milestone 2 after this checkpoint is rebuilt and manually exercised.

### Next action

Perform one native Export → Import round-trip using a temporary local folder before starting folder connection and publication. Milestone 2 will add the folder picker, notebook identity, and durable pending snapshot publication.

## 2026-09-06 — Cloud-folder sync milestone 2

### Implemented

- Added a desktop-only `Sync` action with a native folder picker, connection status, selected-folder display, `Sync now`, `Pause`/`Resume`, and `Disconnect` controls.
- Added a separate per-device `backlogger.sync.json` state file so the portable notebook export remains free of device identity and provider paths.
- Added a stable device ID and notebook ID, plus a `backlogger-sync/notebook.json` manifest and immutable `backlogger-sync/snapshots/<id>.json` exchange layout.
- Connected local task saves to durable pending snapshot publication. Snapshots contain categories/tasks, ancestry IDs, device identity, notebook identity, and a local revision; theme and selected view remain device-local.
- Added retry-safe folder writes: snapshot files are never overwritten with different content, pending snapshots remain queued when a folder is unavailable, and pause stops folder activity while local saves continue.
- Reconnecting after edits made while disconnected compares the last published revision and publishes the local changes once the same notebook folder is available again.
- Added an explicit empty-folder confirmation so a provider folder that is still downloading cannot silently initialize a competing notebook.
- Added protocol/path/state tests for snapshot preference isolation, duplicate pending IDs, manifest validation, and Windows folder paths.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 13 tests.
- `npm.cmd run build`: passed; output is approximately 32.01 kB JavaScript and 6.52 kB CSS before gzip for this checkpoint.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with the sync-state and folder commands.
- `npm.cmd run tauri -- build`: passed; rebuilt `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`.
- Rebuilt installer size: 1,949,091 bytes. SHA-256: `B691D82415330C625E274B9B81A280A8CE379482641734AE8877BBD4A3E89E23`. Authenticode status: `NotSigned`.
- Browser smoke test confirmed the Sync dialog explains that folder sync requires the installed desktop app and leaves its controls disabled in the browser preview.

### Boundary

This is the one-way connect-and-publish increment. It does not fetch remote snapshots, import another device's tasks automatically, merge branches, or resolve conflicts. A second device can attach to the existing notebook and publish an explicit local branch; incoming changes are handled in milestone 3.

### Next action

Milestone 3 will scan snapshots on startup/focus and `Sync now`, validate ancestry, apply safe fast-forward changes, and preserve concurrent edits for explicit conflict resolution.

## 2026-09-06 — Cloud-folder sync milestone 3

### Implemented

- Added native snapshot-directory listing and startup, focus, visibility-resume, timer, and `Sync now` scans.
- Validated immutable snapshot records, notebook identity, duplicate IDs, complete parent ancestry, and provider-delivered partial files. Incomplete snapshot files wait for a later scan instead of replacing local data.
- Added fast-forward application when a remote snapshot descends from the current local snapshot. Incoming categories/tasks are saved locally while the selected view and theme stay device-local.
- Added three-way merge for independent category/task additions and independent task fields. Category order, task order, same-field edits, and delete/edit combinations become durable conflicts rather than guessed overwrites.
- Added a conflict dialog with `Keep mine` and `Use other`. Choices persist locally; the final choice publishes a merge snapshot referencing both branches.
- Deferred incoming changes while a task editor is open, then retried after the editor closes. Existing local edits remain usable when the folder is unavailable.
- Improved second-device joining: an empty local notebook adopts the latest validated shared snapshot before creating a local branch.
- Added ancestry, merge, conflict-resolution, and partial protocol tests.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 15 tests.
- `npm.cmd run build`: passed; output is approximately 44.82 kB JavaScript and 6.86 kB CSS before gzip for this checkpoint.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with native snapshot directory listing.
- `npm.cmd run tauri -- build`: passed; rebuilt `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`.
- Rebuilt installer size: 1,960,951 bytes. SHA-256: `57BE7AB4976F35B51AF23C647C52F35B9AFE749D89A6C48BA7B5227A17E4A40F`. Authenticode status: `NotSigned`.
- Browser smoke test confirmed the Sync dialog and disabled desktop-only controls render without browser errors.

### Boundary

This milestone provides local-folder fetching, safe fast-forwarding, field-level merging, and durable conflict choices. It does not yet claim a full provider-backed two-device acceptance run; that is milestone 4, which will exercise OneDrive and Google Drive folders, verify restart/offline behavior, and confirm the status wording against actual provider delivery.

### Next action

Run provider-backed two-device verification on the rebuilt installer, including a fast-forward change, independent edits, a same-field conflict, pause/offline recovery, and restart with pending snapshots. Fix any provider-specific behavior before the next release checkpoint.

## 2026-09-06 — Cloud-folder sync milestone 4a

### Implemented

- Added durable `lastCheckedAt` and `lastSuccessfulCheckAt` sync metadata, with backward-compatible defaults for existing sync state files.
- Updated the Sync dialog to distinguish `Connected`, `Folder unavailable`, `Conflicts`, and `Paused` states.
- Added the last successful local folder-check time to the status detail. The wording makes clear that a successful local check does not prove that OneDrive or Google Drive has finished uploading or downloading.
- Persisted folder-check success after publish, fetch, connect-to-existing, `Sync now`, and automatic retry cycles. Failed checks retain the error and remain visible for retry.
- Added a protocol test proving older sync state files without folder-check timestamps still load correctly.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 16 tests, including the timestamp compatibility test.
- `npm.cmd run build`: passed; output is approximately 45.94 kB JavaScript and 6.86 kB CSS before gzip for this checkpoint.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `npm.cmd run tauri -- build`: passed; rebuilt `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`.
- Rebuilt installer size: 1,959,166 bytes. SHA-256: `DBFD81967964345C394D1A978A9B47D73B68E706F74D4E42D8BE2F763E4C5CD6`. Authenticode status: `NotSigned`.

### Boundary

This increment improves provider-folder status reporting and state compatibility. It does not claim that a local folder check proves provider delivery. Milestone 4 still needs a native two-device run through at least one real provider, plus offline/restart and conflict checks on the rebuilt installer.

### Next action

Run the provider-backed acceptance checklist on the rebuilt installer. Record which provider and device pair were tested, then fix any filesystem placeholder, delayed-download, permission, or restart behavior found before marking milestone 4 complete.

## 2026-09-07 — Sync recovery and stale-descendant fix

### Incident

- The shared folder contained a valid Device A snapshot at `2026-09-06T13:27:00.586Z` (`23d032cc-50fe-421d-847f-d12c1012719b`, revision 36) and a later Device B snapshot at revision 34 that incorrectly listed the newer snapshots as parents. The old reconciliation path treated that stale record as a descendant and could publish or apply it.

### Implemented

- Sync now reconciles the folder before publishing pending local snapshots, including edits created while a device was offline.
- Pending local snapshots are merged with a newer remote descendant before publication; stale pending records are discarded once their data is represented by the merge or a durable conflict.
- Snapshots whose revision is older than a known parent are ignored as invalid descendants. A device whose current snapshot is invalid or missing can recover the latest complete validated leaf instead of remaining stuck on the stale branch.
- Import now recognizes a valid Backlogger sync snapshot, converts it to the normal local document schema, preserves the current device theme/view, and marks the import as a recoverable local change when connected.
- Created a validated recovery document from the 9:27 PM Device A snapshot at `C:\Users\Albert\Desktop\backlogger-recovery-2026-09-06-21-27.json` (revision 36, 9 categories, 12 tasks). The original sync files were not modified.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 17 tests, including sync-snapshot recovery and stale-parent validation.
- `npm.cmd run build`: passed; output is approximately 48.66 kB JavaScript and 6.86 kB CSS before gzip for this checkpoint.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- `npm.cmd run tauri -- build`: passed.
- Rebuilt installer size: 1,960,265 bytes. SHA-256: `CE9465B79B29916E4DB9518AF6310D421D2B7757677C3C5A8DAB31D501B068F7`. Authenticode status: `NotSigned`.
- The converted recovery JSON was parsed successfully and matches the source snapshot's 9 categories, 12 tasks, and revision 36.

### Boundary

This fixes the observed stale-descendant path and provides recovery for the affected snapshot. The provider-backed acceptance run should still be repeated with the rebuilt installer before declaring sync release-ready.

## 2026-09-07 — Predictable session-based syncing (milestone 5 implementation)

### Implemented

- Added a session state machine with a read-only `Fetching…` phase on startup. Task/category editing, import/export, undo, theme/view changes, and notebook replacement controls stay disabled until the initial shared-folder check finishes or the user continues offline.
- Moved the activity status to a sticky area below the header and view controls. It keeps short save/fetch/offline/error messages and places `Fetch`, `Ignore`, and `Retry fetch` beside the relevant state.
- Replaced automatic per-edit publication with local autosave plus close-time publication. A persisted content fingerprint detects autosaved content that survived a crash or restart and still needs publication.
- Added read-only shared-folder checks on startup, focus/resume, the Sync dialog's `Check for updates` action, and a 15-second polling cycle. A newly delivered validated update remains visible until the user chooses `Fetch` or `Ignore`.
- Bounded each shared-folder check to eight seconds; a timeout enables offline editing and exposes `Retry fetch` instead of leaving the startup lock in place indefinitely.
- Added explicit replacement confirmation before Fetch can replace local edits. Startup/fetch operations back up the current local document first; ambiguous branches remain for explicit Sync resolution.
- Added a native close handler that finishes local writes, rechecks the folder, offers Fetch/Keep mine/Cancel when another branch is present, and preserves a pending publication when the provider folder is unavailable.
- Added parent-existence validation so a pending snapshot cannot publish against history that was pruned or never fully downloaded.
- Added a versioned `checkpoint` snapshot type and best-effort retention. When a single validated branch exceeds the fixed 30-snapshot target, the app publishes a self-contained checkpoint, updates the manifest, then removes old payloads. Branched, conflicted, pending, or concurrently changing histories are left intact and reported in the Sync dialog.
- Manifest metadata records pruned snapshot IDs, so a provider that delays deletion cannot make old payloads look like live competing branches during the next scan.
- Added native exact-file removal support for retention cleanup and persisted sync-state content fingerprints with backward-compatible parsing.

### Verification

- `npm.cmd run check`: passed.
- `npm.cmd test`: passed 18 tests, including checkpoint version validation and the fixed 30-snapshot retention target.
- `npm.cmd run build`: passed; output is approximately 75.70 kB JavaScript and 7.10 kB CSS before gzip for this checkpoint.
- `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`: passed.
- `cargo check --manifest-path src-tauri/Cargo.toml`: passed with native retention cleanup support.
- `npm.cmd run tauri -- build`: passed; rebuilt `src-tauri/target/release/bundle/nsis/Backlogger_0.1.0_x64-setup.exe`.
- Rebuilt installer SHA-256: `4C833FA7E7F7D7FB3410D06360F37F2E53438D5EA0DB15B249D9D8E12AC47A55`. Authenticode status: `NotSigned`; Windows may show an “Unknown publisher” warning.
- Browser smoke check showed the sticky top Activity status and a ready local backlog without console/runtime errors.

### Boundary

The milestone is implemented in the working tree, but release readiness still requires the user's real two-device provider run: startup fetch lock, delayed OneDrive delivery, Fetch/Ignore, close-time divergence, offline close, and more-than-30-snapshot retention. The provider can continue uploading after the app closes; the app only verifies local filesystem writes.

## 2026-09-07 — Close-time publication timeout fix

### Incident

- A close attempt could remain on `Saving before closing…` while a OneDrive filesystem operation waited indefinitely. The native close handler had no bound around publication or some sync-state writes.

### Implemented

- Bound close-time fetch, local save wait, sync-state writes, pending-queue creation, and shared-folder publication to a 12-second operation window.
- If publication times out, the close path keeps the pending snapshot and local content fingerprint durable, then closes with a local copy so the next launch can retry safely.
- If the local save itself times out, the app presents `Keep app open` or `Close with last saved copy` instead of trapping the window.
- The close handler now catches unexpected failures and restores an actionable offline state rather than leaving the native window in the closing phase.

### Verification

- `npm.cmd run check`, `npm.cmd test`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, and `cargo check --manifest-path src-tauri/Cargo.toml`: passed.
- Rebuilt installer SHA-256: `4C833FA7E7F7D7FB3410D06360F37F2E53438D5EA0DB15B249D9D8E12AC47A55`. Authenticode status: `NotSigned`.
