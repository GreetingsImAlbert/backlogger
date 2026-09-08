# Android implementation milestones

Implementation brief extracted from [mobile.md](mobile.md). Setup instructions remain there. User Gate A is complete; recheck tooling only if a command fails. Implement in this repository.

## Instructions for each assigned agent

- Implement only the assigned milestone. Read the shared rules below and that milestone's prerequisites before editing.
- Inspect current files and previous milestone handoffs; paths below describe the starting repository, not a requirement to recreate files already extracted.
- Run milestones 1–6 sequentially. Milestone 0 is required before live-folder access, not before local development. Milestone 7 requires 0 and 1–6; milestone 8 requires 7.
- Preserve unrelated changes. Do not reset the worktree, change the Windows application identifier, or rewrite the sync protocol to simplify the assignment.
- Complete code and mock tests that do not require external setup. If a required account, credential interaction, device, or verified API behavior is missing, report the precise remaining dependency; do not mark its acceptance check passed.
- After completing a milestone, append a concise `Handoff` subsection beneath it with changed files, commands/results, artifact paths, outstanding failures, and interfaces/configuration the next agent must use. Distinguish implemented, mock-tested, emulator-tested, and provider-tested behavior.

## Shared implementation rules

1. Use Tauri 2, the current TypeScript/CSS UI, and existing validation/merge logic. Android saves locally without an account. Windows retains filesystem sync and close-time publication.
2. Production uses the user's existing OneDrive `backlogger-sync` folder, containing `notebook.json` and `snapshots/<snapshot-id>.json`. Do not move, recreate, or reset it. `/backlogger-sync` is the planned root-relative path; verify its actual location and notebook ID before live use instead of inferring location from the name alone.
3. Windows currently stores a **parent directory** and appends `backlogger-sync` in `src/sync/local-folder-transport.ts`. Android stores the **actual sync folder's drive/item IDs**. Never append `backlogger-sync` twice or silently change the existing Windows path.
4. Debug integration tests use `/backlogger-sync-test` and a separate local app-data profile. Release builds resolve only the verified production location. Display the active folder; never use production for destructive tests.
5. Preserve shared protocol versions, notebook/task/category IDs, snapshot ancestry, checkpoints, and conflict semantics. Timestamps and per-device revisions do not determine which device wins.
6. Keep local notebook, backups, device identity, transport location, account state, and pending publications on the device. Shared snapshots exclude theme, view, credentials, and device preferences.
7. Persist local changes and recoverable pending state before network writes. Missing files, incomplete ancestry, invalid JSON, and auth/network failures never mean an empty notebook or task deletion.
8. Published snapshots are immutable. Conflicts and unfinished uploads remain recoverable across restarts. Preserve drafts and require explicit replacement decisions when fetching would discard local changes.
9. MSAL owns tokens in native Android code. No client secret; no token-returning JavaScript commands, token logs, or credentials in JSON/repository files.
10. Scope: Android and OneDrive only. No hosted backend, additional provider, background service, WorkManager job, or separate repository.

## Milestone 0 — Preserve and identify live data

**Prerequisite:** User Gate C from `mobile.md` before accessing the live folder. Local implementation can proceed independently.

**Work:**

1. Resolve the desktop's configured parent directory and actual `backlogger-sync` exchange directory. Verify the corresponding cloud path; do not change desktop settings.
2. After desktop publication and OneDrive delivery finish, make or verify a backup of the complete exchange directory outside OneDrive.
3. Record manifest notebook/protocol IDs and a snapshot inventory with file hashes. Validate the backup using existing parsers without rewriting its files.
4. Record the backup path and validation result in the handoff. Do not publish private notebook contents in logs or documentation.

**Done when:** A recoverable backup and verified location/identity are recorded; original file hashes are unchanged.

## Milestone 1 — Build and run the local Android app

**Prerequisite:** Gate A tooling. No Microsoft registration required.

**Files:** `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, new `src-tauri/src/lib.rs`, Tauri configuration/capabilities, `package.json`, `src/storage.ts`, `src/main.ts`, `src/style.css`, new `src/platform/capabilities.ts`.

**Work:**

1. Move native commands and builder setup into public `run()` in `lib.rs`, with `#[cfg_attr(mobile, tauri::mobile_entry_point)]`. Keep `main.rs` as the Windows launcher; add the library crate configuration required by Tauri mobile.
2. Initialize Android with the installed Tauri CLI (`npm.cmd run tauri -- android init`). Review generated `src-tauri/gen/android` and ignore build output, machine paths, and signing secrets.
3. Move Windows-only NSIS configuration into `tauri.windows.conf.json`; add Android configuration/icons without changing the Windows identifier or data location. Keep single-instance/window-close behavior desktop-only.
4. Replace the assumption that every Tauri runtime is desktop with explicit runtime capabilities: native local storage, native documents, local-folder sync, OneDrive sync, desktop close, mobile lifecycle. Android uses native app-data commands and must not call desktop close handlers or offer desktop folder selection.
5. Verify local temporary/primary/backup writes work on Android. Preserve validation, recovery, serialized saves, and save-error/retry behavior.
6. Adapt safe-area spacing, small-screen dialogs, and touch targets. Retain task/category operations, date views, theme, Undo, and pointer reordering.
7. Keep unfinished Android OneDrive/import/export actions visibly unavailable until their milestones implement them. Do not report success from placeholder handlers.
8. Add repeatable Android dev/debug-build commands. Configure Vite/device access if needed for `android dev`; verify the packaged APK also works without the dev server.

**Verify:** Run frontend checks/tests/build and Windows Cargo check. Build/install an Android debug APK; launch via `adb`, create/edit/move/reorder/delete tasks and categories, then force-stop/relaunch and verify persistence. Capture screenshots and relevant crash logs. Check keyboard, portrait/landscape, and theme.

**Handoff:** Exact Android package ID, build/install commands, APK path, device serial, and any temporarily disabled actions.

## Milestone 2 — Separate sync logic from transport

**Prerequisite:** Milestone 1.

**Files:** `src/sync.ts`, sync orchestration currently in `src/main.ts`, native file commands, `tests/sync.test.mjs`; introduce `src/sync/transport.ts`, `coordinator.ts`, and `local-folder-transport.ts` as needed.

**Work:**

1. Extract filesystem I/O behind a typed transport with: connect/resolve location, read manifest with version metadata, write manifest with expected version, list/read snapshots, create immutable snapshot, and delete snapshot.
2. Define the referenced location, remote-entry, versioned-result, and error types explicitly. Remote entries need a transport ID and display filename; protocol code must not construct Windows paths or Graph URLs.
3. Wrap existing commands in `LocalFolderSyncTransport`. Keep validation, ancestry, merging, session decisions, pending publication, and retention in shared code above the adapter.
4. Represent conditional-write capability honestly: a local filesystem check is best-effort, not atomic Graph ETag comparison. Never claim either transport locks the entire shared history.
5. Version device-local sync state. Back up and migrate existing `folderPath` to `{ kind: 'local-folder', parentPath }` while preserving all IDs, accepted ancestry, pending work, and conflict choices. Define OneDrive location fields: `accountId`, `driveId`, `rootItemId`, `displayPath` (including debug path).
6. Keep portable imports/exports free of transport state. Disconnect retains recoverable local work; reconnection validates notebook identity before publication.
7. Add a debug Windows profile/root override so Windows and Android can exchange through `/backlogger-sync-test` without altering the production profile. Merely selecting that directory as the current parent would create an incorrect nested folder; resolve the test exchange root explicitly.

**Verify:** Existing tests pass; legacy state migrates with pending work intact. Two isolated profiles exchange sequential and concurrent edits, preserve conflicts, and survive restart. Windows native sync/close behavior remains operational. Rebuild the Android shell after extraction.

**Handoff:** Exported interfaces, adapter locations, migration version, debug profile/root commands, and coordinator entry points.

### Milestone 2 handoff

- Transport types and capabilities: `src/sync/transport.ts`.
- Windows filesystem adapter: `src/sync/local-folder-transport.ts`; shared parsing/indexing boundary: `src/sync/coordinator.ts`.
- `SyncState` is schema version 2 with `location: { kind: 'local-folder', parentPath }` or a future OneDrive binding. Legacy version 1 `folderPath` state is migrated and backed up through the native `backup_sync_state` command before rewrite.
- Local conditional manifest writes are explicitly best-effort content-version checks; they are not Graph-style atomic ETag writes. Immutable snapshot creation remains idempotent and rejects different content under an existing ID.
- For isolated Windows exchange, set `VITE_BACKLOGGER_SYNC_PROFILE=test` and `VITE_BACKLOGGER_SYNC_TEST_ROOT=<exact exchange folder>` before `npm.cmd run tauri -- dev`. Production ignores the override; normal production paths still append `backlogger-sync` to the selected parent.
- Verification: `npm.cmd run check`, `npm.cmd test` (27 passing), `npm.cmd run build`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `cargo check --manifest-path src-tauri/Cargo.toml`, `npm.cmd run android:build`, and `npm.cmd run tauri -- build --ci` passed. The rebuilt APK installed/launched on `emulator-5554`; persisted Android test records remained present and no Backlogger crash was observed.
- No live OneDrive access or actual two-process native folder exchange was performed in this refactor. The coordinator boundary has an isolated in-memory transport test; provider authentication, Graph transport, and two-device acceptance remain later milestones.

## Milestone 3 — Native Microsoft authentication

**Prerequisites:** Milestones 1–2. Gate B client ID, Android redirect/package/certificate configuration, and user login are required for real authentication verification.

**Files:** Local Tauri Android plugin (Kotlin and Rust registration), generated Android Gradle integration, Tauri command permissions, TypeScript account/settings bridge.

**Work:**

1. Add MSAL Android in single-account public-client mode with delegated `Files.ReadWrite`. Use the supported browser/broker authorization flow and PKCE; MSAL owns token caching and silent renewal.
2. Expose sign-in, sanitized account state, and sign-out to the UI. Keep token acquisition internal for subsequent Graph operations.
3. Document the exact non-secret configuration fields and debug certificate/redirect setup. Missing registration shows an actionable configuration state rather than a crash.
4. Sign-out preserves local content/pending work but stops remote activity. On account change, invalidate the active remote binding and require validation and an explicit join decision before any upload.
5. Restrict native command permissions. Never accept arbitrary authenticated URLs from the frontend.

**Verify:** Build the plugin, test missing configuration/cancel/error/account-change handling, then let the user complete emulator sign-in. Verify silent acquisition after restart and sign-out. Inspect logs/bridge results for credential exposure. Without login, report real authentication verification as pending.

**Handoff:** Plugin command names, account model, error codes, configuration path, and authentication test result.

## Milestone 4 — Read OneDrive through Graph

**Prerequisite:** Milestone 3; authenticated account for provider checks. Start with the debug folder. Milestone 0 and Gate C apply before production reads.

**Files:** Native plugin Graph client; `src/sync/onedrive-transport.ts`; coordinator and Sync UI.

**Work:**

1. Resolve the configured root-relative sync folder through Graph, verify its folder facet, then bind account/drive/item IDs. Read `notebook.json` and resolve `snapshots` beneath that item. Never create a production folder or manifest on lookup failure.
2. Follow all child-list pages. Fetch contents natively, handle download redirects without forwarding Graph bearer tokens to other hosts, and do not persist short-lived download URLs.
3. Pass bytes and metadata to existing shared parsers. Validate protocol/notebook IDs, snapshot identity/content, parent ancestry, and checkpoint metadata. Detect duplicate snapshot IDs even under renamed filenames.
4. Integrate startup fetch, bounded timeout, `Continue offline`, and `Shared update available` with Fetch/Ignore. Preserve editor drafts and unpublished changes. Polling must not silently replace the visible notebook.
5. Return sanitized errors for missing folder, invalid remote data, permission loss, offline state, throttling, and sign-in required. Follow `Retry-After` and bounded backoff for transient failures; silently refresh once after expired auth.
6. Enforce read-only mode at the native write boundary for this milestone's provider validation.

**Verify:** Mock pagination, redirects, expired URLs/auth, `403`/`404`/`429`/`5xx`, malformed files, wrong notebook, missing parents, and duplicate IDs. With an isolated fixture, verify expected heads. When live reads are authorized, compare actual history with the desktop and show unchanged cloud inventory/hashes.

**Handoff:** Folder binding, request/error mapping, read-only control, fixture results, and whether live-read validation occurred.

## Milestone 5 — Publish snapshots safely

**Prerequisite:** Milestone 4. Provider writes in this milestone use `/backlogger-sync-test` only.

**Work:**

1. Implement confirmed initialization of an empty debug folder using a fresh test notebook ID. Never run this initializer for production.
2. Persist the snapshot and its accepted parents locally before upload. Create `snapshots/<id>.json` with conflict-failure semantics. On a duplicate name, read and compare validated content; accept identical content and reject different content.
3. Treat a timeout after upload as uncertain: re-read the same ID before retrying. Keep publication bookkeeping durable until every required remote step is confirmed; a snapshot uploaded before a failed manifest update must remain recoverable.
4. Read manifest plus ETag, preserve concurrent heads/pruned metadata, and conditionally update using a verified Graph endpoint. On `412`, re-read/reconcile and retry a bounded number of times. Do not fall back to unconditional overwrite.
5. Verify actual endpoint precondition/conflict behavior against the supported account type. If unsupported, leave writes blocked and report the specific contract failure for redesign.
6. Scan snapshot history as well as manifest heads: the existing Windows close publisher can write a snapshot before/without a manifest update. Preserve concurrent branches and never attach unseen heads as parents of stale content.
7. Implement remote checkpoint/retention operations using the existing protection rules and remote item IDs. Confirm checkpoint and manifest before deletion; tolerate an already deleted file. Keep Android cleanup disabled until isolated concurrent/interrupted-cleanup tests pass.
8. Account for mixed transports: Graph ETags cannot prevent a later Windows OneDrive client from uploading a stale manifest. Test late filesystem delivery and compaction races explicitly; do not claim ETags alone solve them. If retention safety cannot be demonstrated, defer cleanup and report it as an unresolved release check.

**Verify:** Identical/different duplicate IDs; failed/uncertain upload; uploaded snapshot with failed manifest; two publishers; ETag races; offline restart; late Windows delivery; more than 30 publications; interrupted compaction; unresolved branches and a returning device with pruned ancestry. No test may lose a branch or overwrite an immutable snapshot.

**Handoff:** Verified Graph write endpoints, retry/recovery behavior, cleanup enablement state, and isolated provider evidence.

## Milestone 6 — Android lifecycle, documents, and final UI

**Prerequisite:** Milestone 5.

**Files:** Shared coordinator, Kotlin lifecycle/document bridge as needed, `src/platform/documents.ts`, `src/main.ts`, `src/style.css`.

**Work:**

1. Autosave committed edits immediately; persist recoverable pending intent before relying on a timer. On foreground idle, coalesce edits into a full snapshot; never mutate a snapshot whose upload may have started.
2. Check remote history before publication on launch/resume/reconnect. Run one cycle at a time. Suspend polling when backgrounded; a background publication attempt is best-effort. Restart must recover without any close callback.
3. Keep Check for updates, Fetch/Ignore, Sync now, Pause/Resume, Disconnect, and Sign in again coherent. Pause stops network activity while local saves continue. Ignoring an update never authorizes overwriting it.
4. Implement Android document import/export using content URI streams. Validate/preview imports and preserve backup/replacement semantics. Cancellation is neutral; export succeeds only after the write closes successfully. Do not pass content URIs to Rust filesystem-path functions.
5. Finish safe areas, keyboard visibility, touch controls, reordering/scroll interaction, readable errors, account/folder display, landscape/font scaling, and accessibility. Remove temporary disabled-action placeholders from milestone 1.

**Verify:** Process termination after local save and at publication boundaries; offline edit/restart/reconnect; rapid edits; resume; revoked auth; account change with pending edits; fetch with an active draft; pause/disconnect; actual document round trip and cancellation. Capture emulator UI/log evidence; record physical touch/TalkBack checks separately if no phone is available yet.

## Milestone 7 — Windows and Android live-folder acceptance

**Prerequisites:** Milestones 0–6, passed isolated tests, completed live read-only validation, and Gate C authorization for live writes.

**Work and acceptance:**

1. Verify both clients bind the same existing folder and notebook ID. Confirm no nested folder or new notebook was created.
2. Windows edit → close publication → OneDrive delivery → Android fetch; Android edit → Graph publication → Windows OneDrive delivery → desktop fetch. Check actual content, not merely a success label.
3. Reproduce Windows-current/Android-stale startup, delayed delivery, offline independent edits, same-field conflict, and delete/edit conflict. Safe merges converge; conflicting values remain recoverable until explicitly resolved.
4. Test Ignore then publish, fetch with local work/draft, auth loss, and Android force-stop/restart. Confirm no stale overwrite, resurrection, or publication to an unconfirmed account.
5. Keep bulk retention/destructive scenarios in the isolated folder; use only controlled user-approved changes for live acceptance. Preserve the backup.

**Done when:** This milestone's handoff records both directions and concurrency/recovery outcomes with device/build IDs and evidence. Any unresolved protocol or retention race is a failed release check, not a documentation-only limitation.

## Milestone 8 — Signed release and regression

**Prerequisites:** Milestone 7 and Gate D release identity/key, Entra release certificate registration, physical phone. Play Console is needed only for store submission.

**Work:**

1. Configure release signing from external secrets; exclude keys/passwords from source control. Keep Windows identity and app-data path unchanged.
2. Verify release native code cannot enable debug folder overrides or test initialization. Build signed APK and AAB with repeatable commands; document exact artifact paths.
3. Install the signed APK on the physical phone. Repeat local persistence, document import/export, login/renewal, two-way sync, offline restart, and lifecycle checks. Verify keyboard, touch drag, safe areas, font scaling, rotation, and TalkBack.
4. Run frontend checks/tests/build, Windows Cargo checks, and Windows installer build. Smoke-test existing Windows persistence, native documents, and folder sync.
5. Update README with build/install commands, non-secret Entra setup, `Files.ReadWrite` explanation, folder/profile configuration, foreground sync behavior, and recovery instructions. Record completed evidence in this milestone's handoff.

**Done when:** Signed phone build and Windows regression pass, outstanding release checks are resolved, and reproducible artifacts/commands are handed off. Store upload is a separate action.
