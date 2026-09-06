# Implementation progress

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
