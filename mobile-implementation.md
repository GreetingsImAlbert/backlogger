# Android implementation plan

Status: Android shell and native local persistence are complete. Android sync and document import/export remain disabled. Windows already uses the record-level Supabase v2 protocol described below; Android must integrate that exact protocol rather than the retired snapshot protocol.

Backlogger remains one Tauri 2 repository. Windows and Android share TypeScript, CSS, Rust, SQLite schema, and sync modules, but their release versions may differ. Local-only use must always work without an account or network.

## Rules for every milestone

- Implement only the assigned milestone and preserve unrelated work and Windows behavior.
- Keep `local.backlogger.desktop`, the Windows app-data location, and `src-tauri/tauri.windows.conf.json` unchanged.
- Reuse `LocalRepository` and `src/sync-v2/`; do not create Kotlin data/sync logic, a native Supabase SDK, or another protocol.
- Network or auth failure must never disable local editing. Persist edits and outbox intent before network work.
- Never store credentials, device identity, sync bindings, bases, cursors, or outbox entries in portable exports.
- Do not add WorkManager, background services, or notifications. Android foreground resume plus cursor catch-up is the correctness boundary.
- The user runs all Supabase commands and Git commits. No mobile-specific database migration is expected.
- After implementation, append a short `### Milestone N handoff` containing changed files, checks, APK path/hash, emulator/device evidence, remaining user action, and stable interfaces for the next milestone.

## Required setup gates

### Gate A — Android toolchain (complete; recheck before diagnosing builds)

```powershell
& "$env:JAVA_HOME\bin\java.exe" -version
node --version
npm.cmd --version
rustup target list --installed
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices -l
& "$env:ANDROID_HOME\emulator\emulator.exe" -list-avds
Test-Path -LiteralPath $env:NDK_HOME
```

Expected Rust targets: `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, and `x86_64-linux-android`. Windows Developer Mode must remain enabled for Tauri symlinks.

### Gate B — mobile OAuth callback (required before Milestone 3 runtime testing)

The user verifies:

1. Supabase Authentication → URL Configuration allows exactly `backlogger://auth/callback`; retain the Windows loopback callback.
2. The existing Google provider remains enabled. Do not create another Google project/client or expose its secret.
3. `.env.local` contains only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`.
4. A Google Play-enabled emulator with a working browser is booted.
5. The user personally completes Google account selection and browser-to-app prompts.

### Gate C — hosted sync testing (required before Milestone 4 acceptance)

- Use the already-migrated Supabase development project and a disposable account/notebook first.
- Complete Google login on a Windows test installation and the Android emulator using the same account.
- If the database contract changes unexpectedly, stop and ask the user to run the full Supabase workflow in `AGENTS.md`.
- Before connecting current data, export the Windows notebook and let Windows finish syncing.

### Gate D — signing and physical device (required for Milestone 8)

- The user creates and backs up the keystore and passwords outside the repository.
- Signing reads ignored environment/Gradle properties; secrets and signed artifacts are never committed.
- Connect an arm64 phone and approve USB or wireless debugging. Play Console access is optional for direct APK distribution.

## Standard verification

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run security:secrets
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
npm.cmd run android:build
```

For emulator work, record the device serial/API/ABI, install result, launch result, screenshots/UI tree, filtered logcat, APK path, and SHA-256. Compilation alone is not runtime evidence.

## Milestone 1 — Android shell and local persistence (complete)

- Shared Tauri entry point, Android project generation, x86_64 debug packaging, responsive shell, and native SQLite persistence are implemented.
- Local create/edit/delete/reorder, dates, deadlines, preferences, backups, restart recovery, and offline use must remain working.
- Android sync and document import/export remain capability-gated.

## Milestone 2 — Shared record-sync foundation (complete on Windows)

Android must reuse these existing components unchanged unless an Android-specific defect is proven:

- `src/local-db/`: SQLite records, acknowledged bases, coalesced outbox, cursor, sync state, preferences, and recovery backups.
- `src/sync-v2/types.ts` and `validation.ts`: category/task records with stable IDs, field clocks, `updatedAt`, `version`, `deletedAt`, `sortKey`, and `changeSeq`.
- `merge.ts` and `ordering.ts`: three-way field merge, latest-clock same-field resolution, delete-wins, category tombstone cascade, and deterministic ordering.
- `supabase-transport.ts` and `worker.ts`: authenticated v2 RPCs, ordered delta pull, OCC push, pull–push–pull cycles, bounded stale retry, and durable restart recovery.
- `realtime.ts`: one notebook-scoped channel whose events only wake validated cursor pulls; polling remains the fallback.
- `bootstrap.ts`: v2 discovery and atomic initialization. Legacy snapshot migration is Windows-only rollback support.
- `rollout.ts` and `status.ts`: staged protocol selection and concise status presentation.

The existing `sync_v2_*` tables, ledger, sequence, RPCs, RLS, grants, and Realtime publication are authoritative. Android currently has `cloudSync`, `supabaseSync`, and `recordSync` disabled.

## Milestone 3 — Android Google login and deep-link return

**Prerequisites:** Gates A–B. **Likely files:** `src/supabase/auth.ts`, platform capabilities, Tauri deep-link configuration, focused auth tests.

1. Register the mobile `backlogger` scheme and exact route `backlogger://auth/callback`. Preserve the Windows scheme and loopback flow.
2. Select OAuth redirect by runtime: Windows uses its loopback listener; Android uses the custom deep link and never invokes the Windows listener; browser preview stays local-only.
3. Keep Supabase PKCE, `skipBrowserRedirect`, `openid email profile`, pending-flow expiry, exact callback validation, and one-time code exchange.
4. Deliver warm, backgrounded, and cold-start Android URLs. Use Tauri `onOpenUrl`; add the narrowest native fallback only if cold-start delivery is proven missing.
5. Restore the session after force-stop. Logout removes the session but preserves the local notebook and record-sync binding/outbox.
6. Closing/canceling browser login, duplicate/expired callbacks, offline exchange, and process death must return the UI to retryable—not permanent `Signing in`.
7. Expose auth separately if needed, but keep Android `recordSync` disabled throughout this milestone. Login must perform no cloud writes.

**Verify:** unit tests plus emulator intent routing; reject a forged callback without a pending verifier; user completes real warm/background/cold login, cancellation, session restore, wrong-account handling, and logout. Secret scan the APK and logs.

**Done when:** Android auth reliably returns, restores, cancels, and logs out without publishing or affecting local editing.

## Milestone 4 — Enable Supabase record sync on Android

**Prerequisites:** Milestone 3 and Gate C. **Likely files:** platform capabilities, `src/main.ts`, `src/sync-v2/bootstrap.ts`, Android capability tests.

1. Verify Android WebView access to the configured Supabase HTTPS endpoint. Missing/invalid public configuration leaves local-only mode available.
2. Enable Android `cloudSync`, `supabaseSync`, and `recordSync` only for the v2 protocol. Do not enable or write through legacy snapshots/manifests.
3. On login, inspect v2 read-only. If v2 exists, validate account/project/notebook binding, bind `LocalRepository`, then start `RecordSyncWorker`.
4. If v2 does not exist, require explicit **Start sync**, then initialize atomically from local records. If legacy cloud rows exist without v2, instruct the user to migrate once with the current Windows build; do not duplicate legacy migration on Android.
5. Preserve local records when joining an existing notebook. Let the existing base/outbox/field-clock reconciliation upload local-only edits, apply server-only edits, merge different fields, resolve same-field edits by clock/device ID, and make deletion win.
6. Account/project/notebook mismatch, RLS denial, invalid data, or unavailable cloud state must retain local data and show a safe retry/export action. Email is display-only.
7. Remove routine Fetch/Merge behavior on Android. Keep only Start sync, Pause/Resume, Retry, Logout, account-mismatch guidance, and recovery export.

**Verify:** disposable account tests for no-write login, explicit initialization, existing-v2 join, local-only and server-only records, wrong account, offline startup, restart, and Windows↔Android polling convergence. Confirm only owned `sync_v2_*` rows change.

**Done when:** Windows and Android converge through the same v2 cursor/OCC protocol without legacy writes or manual conflict repair.

## Milestone 5 — Android lifecycle, Realtime, and durable recovery

**Prerequisite:** Milestone 4. **Likely files:** `src/sync-v2/realtime.ts`, a focused platform lifecycle adapter, `src/main.ts`, lifecycle tests.

1. Foreground startup order is authenticate/bind → subscribe → cursor catch-up → push outbox → final pull. Never apply Realtime payloads directly.
2. Keep exactly one authenticated notebook channel. Refresh its JWT; tear it down before logout, account/notebook change, pause, or background.
3. On foreground/network return, subscribe before catch-up. Coalesce socket events; keep periodic foreground pulls when Realtime is degraded.
4. Backgrounding stops channels and polling after local SQLite work finishes. A best-effort sync request is allowed, but correctness must rely on the persisted outbox.
5. Survive force-stop at local commit, outbox save, request, server accept, acknowledgement, delta apply, cursor save, subscription, and token refresh boundaries.
6. Keep editing enabled while offline/auth-failed. Show only `Syncing…`, `Offline`, `Sync failed`, or `Paused`; detailed causes stay behind the information control.

**Verify:** Home/resume, rotation, offline edits, network switching, dropped socket, token refresh, pause/resume, logout, process kill, and restart catch-up. Prove no duplicate channel, duplicate/recreated record, lost acknowledged edit, tombstone resurrection, infinite retry, or close-event dependency.

**Done when:** connected changes normally arrive within seconds, while disabling Realtime changes latency—not correctness.

## Milestone 6 — Android document import/export and mobile UX

**Prerequisite:** Milestone 5. This milestone must not change sync semantics.

1. Use Android system document providers and content streams; never pass `content://` URIs into filesystem-path APIs.
2. Import validates the full portable document, previews and confirms replacement, creates a recovery backup, then commits through `LocalRepository`. Cancellation or invalid/future data changes nothing.
3. Export writes only active portable notebook content and succeeds only after the stream closes. Exclude preferences not in the portable schema and all auth/sync/device state.
4. Enable `documentImportExport` only after a real emulator round trip.
5. Finish safe areas, touch targets, keyboard avoidance, portrait/landscape dialogs, theme/font scaling, TalkBack labels, and focus restoration.
6. Ensure touch reordering does not fight scrolling; retain Move up/down and keep tasks within their category.

**Verify:** provider round trip, cancellation, denied/revoked access, unwritable destination, malformed/future JSON, interruption, recovery, rotation, keyboard, smallest viewport, TalkBack, and touch reorder.

**Done when:** documents and mobile UI work without raw paths, inaccessible controls, data loss, or Windows regression.

## Milestone 7 — Windows/Android acceptance

**Prerequisites:** Milestones 3–6 and disposable tests.

1. Use distinct device IDs with one disposable account/notebook. Verify initialization, sequential edits both ways, concurrent different-field edits, same-field edits in both clock orders, delete/edit, category-delete/task-edit, reorder collisions, and offline-day recovery.
2. Repeat request/acknowledgement/cursor/socket/auth/process interruption cases and reinstall/reconnect. Verify outbox recovery and one active channel.
3. Confirm another user cannot read or mutate the notebook. The user performs any linked database tests/inspection.
4. Export current Windows data, let it finish syncing, then join Android read-only first. After user approval, make one controlled edit each direction and one offline conflict.
5. Run all standard checks plus Windows and Android packaging. Secret-scan source, APK, executable, installer, logs, and portable exports.

**Done when:** both platforms converge without lost/duplicated/resurrected records, local-only use remains independent, and Windows behavior/identity/data location are unchanged.

## Milestone 8 — Signed arm64 release

**Prerequisites:** Milestone 7, Gate D, and an Android version chosen by the user.

1. Add ignored external signing configuration; never commit keystore paths, aliases, or passwords.
2. Keep Android version independent from the Windows-only override. Add repeatable signed arm64 APK and optional AAB commands.
3. Build, SHA-256 hash, install, and test the signed APK on the physical phone; build/hash the AAB only if store distribution is planned.
4. Repeat local persistence, force-stop, OAuth restore/cancel/logout, two-way live/offline sync, documents, rotation, keyboard, touch, font scaling, TalkBack, recovery, update install, and reinstall/reconnect.
5. Rebuild/smoke-test Windows and update release documentation with artifact names, hashes, direct-install instructions, optional sync behavior, foreground limitations, recovery/export guidance, and signing procedure without secrets.

**Done when:** the signed arm64 APK passes physical-device acceptance, optional AAB is reproducible, security checks pass, and Windows remains unaffected.

## Final release criteria

- Local-only Android use works without login/network and survives force-stop and upgrades.
- Google PKCE login handles warm/cold return, cancellation, restoration, logout, and account mismatch without exposing secrets.
- Windows and Android share the SQLite repository and Supabase v2 record/OCC/cursor/Realtime protocol.
- Login is read-only; first initialization requires Start sync; routine conflicts reconcile automatically.
- Soft deletes prevent resurrection; offline outbox work and cursor application survive process death.
- Realtime is foreground-only optimization with polling/cursor recovery, never the sole correctness mechanism.
- Import/export and mobile accessibility pass on a physical arm64 phone.
- Platform versions remain independent; Windows identifier and app-data location remain unchanged.
