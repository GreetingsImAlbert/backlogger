# Android implementation plan

Status: Milestones 1–4 are complete and accepted. Milestone 5 foreground Realtime and lifecycle recovery are implemented; hosted Realtime acceptance is still required. Android document import/export remains disabled. Windows and Android share the record-level Supabase v2 protocol, polling recovery, restored-session handling, and Realtime wake-ups rather than the retired snapshot protocol.

Backlogger remains one Tauri 2 repository. Windows and Android share TypeScript, CSS, Rust, SQLite schema, and sync modules, but their release versions may differ. Local-only use must always work without an account or network.

## Rules for every milestone

- Implement only the assigned milestone and preserve unrelated work and Windows behavior.
- Keep `local.backlogger.desktop`, the Windows app-data location, and `src-tauri/tauri.windows.conf.json` unchanged.
- Reuse `LocalRepository` and `src/sync-v2/`; do not create Kotlin data/sync logic, a native Supabase SDK, or another protocol.
- Network or auth failure must never disable local editing. Persist edits and outbox intent before network work.
- Never store credentials, device identity, sync bindings, bases, cursors, or outbox entries in portable exports.
- Do not add WorkManager, background services, or notifications. Android foreground resume plus cursor catch-up is the correctness boundary.
- Preserve both `https://*.supabase.co` and `wss://*.supabase.co` in the CSP. Realtime requires WSS.
- Treat `src-tauri/gen/` as disposable generated output. Put durable Android configuration in tracked Tauri config, capabilities, Rust, and package files.
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

1. Supabase Authentication → URL Configuration allows `backlogger://auth/callback`; retain the existing Windows loopback callback entries.
2. The existing Google provider remains enabled. Its Google redirect URI stays the Supabase Auth callback—not the `backlogger://` URI. Do not create another Google project/client or expose its secret.
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

For emulator work, record the device serial/API/ABI, install result, launch result, screenshots/UI tree, filtered logcat, APK path, and SHA-256. Inspect the packaged manifest for the exact callback intent filter and Internet permission. Compilation alone is not runtime evidence.

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
- Realtime uses Supabase's current callback-managed auth, cancels an in-flight subscription before stop/pause, and creates a fresh connection on resume. Do not reintroduce a captured startup token or an unresolved connect promise.
- `bootstrap.ts`: v2 discovery and atomic initialization. Legacy snapshot migration is Windows-only rollback support.
- `rollout.ts` and `status.ts`: staged protocol selection and concise status presentation.
- Startup restoration coalesces duplicate auth events, retries transient inspection failures, and recreates a missing runtime on Resume. Android must preserve these close/reopen guarantees.

The existing `sync_v2_*` tables, ledger, sequence, RPCs, RLS, grants, and Realtime publication are authoritative. Android has `cloudSync`, `supabaseSync`, and `recordSync` enabled from Milestone 4; Milestone 5 enables foreground `realtimeSync` while retaining polling recovery.

## Milestone 3 — Android Google login and deep-link return

**Prerequisites:** Gates A–B. **Likely files:** `src/supabase/auth.ts`, `src/platform/capabilities.ts`, `src/main.ts`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/mobile.json`, focused auth/capability tests.

1. Make `tauri-plugin-deep-link` and `tauri-plugin-opener` dependencies and initialization available on Android. Keep dialog, desktop single-instance handling, and the loopback listener implementation/command registration desktop-only.
2. In tracked Tauri config, add a mobile deep-link entry limited to scheme `backlogger`, host `auth`, and path `/callback`. Add `deep-link:default` and a narrowly scoped `opener:allow-open-url` for the Supabase authorize endpoint to `mobile.json`; do not rely on hand-edited generated manifests.
3. Select OAuth behavior from `platformCapabilities().runtime`, not merely “is Tauri”: desktop starts the loopback listener, Android uses exactly `backlogger://auth/callback`, and browser preview stays local-only. Android must never invoke `start_oauth_callback_listener`.
4. Open the authorization URL in the system browser. Keep Supabase PKCE, `skipBrowserRedirect`, `openid email profile`, pending-flow expiry, exact scheme/host/path validation, and one-time code exchange.
5. After obtaining the Supabase auth client but before awaiting session restoration, install the URL listener and process both `onOpenUrl` and `getCurrent()` through one deduplicating handler. Android must handle warm, backgrounded, and cold-start callbacks without depending on the desktop fallback event.
6. Prove the packaged app is classified as Android; if WebView user-agent detection is not reliable, replace it with a reliable Tauri platform discriminator before enabling auth.
7. Restore the session after force-stop. If Android WebView storage is proven unreliable, add a narrow app-private session-storage adapter; never put tokens in portable data, logs, or source.
8. Closing/canceling browser login, duplicate/expired callbacks, offline exchange, and process death must return the UI to retryable—not permanent `Signing in`. Logout removes the session but preserves the local notebook and sync state.
9. Add a separate `supabaseAuth` capability so Android can show/enable Google login without opening any data-sync path. Keep Android `cloudSync`, `supabaseSync`, `recordSync`, and Realtime disabled throughout this milestone; every inspection/write/startup path must still require its sync capability. Login must perform no cloud writes.

**Verify:** unit tests assert redirect/command behavior for browser, desktop, and Android. Inspect the merged manifest, then use `adb shell am start -a android.intent.action.VIEW -d "backlogger://auth/callback"` to prove routing without a real code. Reject callbacks without the pending PKCE verifier. The user completes real warm/background/cold login, browser cancellation, force-stop/reopen restoration, wrong-account handling, and logout. Secret-scan the APK and logs.

**Done when:** Android auth reliably returns, restores, cancels, and logs out without publishing or affecting local editing.

### Milestone 3 handoff

- Implemented Android-only Supabase auth capability, system-browser PKCE, exact `backlogger://auth/callback` routing, warm/cold URL delivery, native return cancellation, and persisted-session restoration without enabling cloud data access. The Windows loopback command remains desktop-only.
- Durable configuration is in `src-tauri/tauri.conf.json`, `src-tauri/capabilities/mobile.json`, `src-tauri/Cargo.toml`, and `src-tauri/src/lib.rs`; `src-tauri/gen/` remains generated and ignored.
- Verification passed: TypeScript, 122 tests, production build, Rust format/check, secret scan, and x86_64 debug APK build. The packaged manifest contains Internet permission and the exact scheme/host/path intent filter.
- Emulator evidence: API 36 x86_64 `emulator-5554`; install/launch, cold and warm deep links, unrequested-callback rejection, browser open/return cancellation, local editing availability, and hidden Start sync/data controls passed with an empty crash buffer.
- Emulator APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`; SHA-256 `D8B6F93F24D04FC2E664B812DC929AEB5C3F9AFBBD026017470259C0621D9100`.
- ARM64 optimized APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/Backlogger_0.1.0_android-arm64-m3.apk`; 17.16 MiB; SHA-256 `73699E2163A9E26061E0DEA4FCA1D6648518A9EE01E25F8537C531E02AE8AEEA`. It uses the existing Android debug certificate for local testing; production signing remains Gate D/Milestone 8.
- User acceptance completed: real Google login, warm/cold return, force-stop/reopen restoration, cancellation, logout, and wrong-account presentation passed before Milestone 4 began.

## Milestone 4 — Enable Supabase record sync on Android

**Prerequisites:** Milestone 3 and Gate C. **Likely files:** `src/platform/capabilities.ts`, `src/main.ts`, `src/sync-v2/bootstrap.ts`, runtime/capability tests.

1. Verify the packaged app has Internet access and the CSP permits the configured Supabase HTTPS and WSS endpoints. Missing/invalid public configuration leaves local-only mode available.
2. Add an explicit `realtimeSync` capability/policy. Enable Android `cloudSync`, `supabaseSync`, and v2 `recordSync` here, but keep Android `realtimeSync` false until Milestone 5. Desktop Realtime remains enabled.
3. Allow `RecordSyncWorker` plus immediate/periodic cursor pulls to run without constructing `SupabaseRealtimeManager`; do not fork the protocol or transport.
4. On login, inspect v2 read-only. If v2 exists, validate account/project/notebook binding, bind `LocalRepository`, perform catch-up, then start polling. Login alone still makes no cloud write.
5. If v2 does not exist, require explicit **Start sync**, then initialize atomically from local records. Split the bootstrap policy so Android never imports or publishes the legacy snapshot protocol. If legacy-only state is detected, block initialization and direct the user to migrate once with the current Windows build.
6. Preserve local records when joining an existing notebook. Let the existing base/outbox/field-clock reconciliation upload local-only edits, apply server-only edits, merge different fields, resolve same-field edits by clock/device ID, and make deletion win.
7. Account/project/notebook mismatch, RLS denial, invalid data, or unavailable cloud state must retain local data and show a safe retry/export action. Email is display-only.
8. Keep only Start sync, Pause/Resume, Retry, Logout, account-mismatch guidance, and recovery export; do not restore snapshot-era Fetch/Merge controls.

**Verify:** disposable account tests for no-write login, explicit initialization, existing-v2 join, blocked legacy-only state, local-only and server-only records, wrong account, offline startup, pause/resume, force-stop/reopen, and Windows↔Android polling convergence. Confirm Android opens no Realtime channel and only owned `sync_v2_*` rows change.

**Done when:** Windows and Android converge through the same v2 cursor/OCC protocol without legacy writes or manual conflict repair.

### Milestone 4 handoff

- Enabled Android `cloudSync`, `supabaseSync`, and v2 `recordSync`; added explicit `realtimeSync: false` and `legacySnapshotMigration: false` policies. Windows keeps Realtime and its one-time legacy migration path.
- `src/main.ts` now starts the shared `RecordSyncWorker` with immediate and periodic polling when Realtime is disabled, performs foreground/network catch-up, restores bound sessions, respects Pause for timers and local edits, and exposes Retry only after polling failures.
- Android login inspection remains read-only. Start sync is still required before binding or initializing. Legacy-only cloud state is detected without importing snapshots and directs the user to migrate once from Windows.
- Added `src/sync-v2/runtime.ts` lifecycle helpers and focused coverage for polling startup, offline retryability, Pause/Resume/Stop, and Realtime delegation. No Supabase schema or migration changed.
- Verification passed: TypeScript, 125 tests, production build, Rust format/check, secret scan, x86_64 debug build, and ARM64 optimized build. API 36/x86_64 emulator install/launch, v2 UI gating, signed-out local editing, force-stop persistence, and empty crash/token/Realtime log checks passed.
- Emulator APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`; SHA-256 `D7935E6C402171906B32E2F03DC3206058173793917321FAF84F41A1510D219F`.
- ARM64 optimized APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/Backlogger_0.1.0_android-arm64-m4.apk`; 17.16 MiB; SHA-256 `0E49B3AC948ECA403BD92D9E555428870124222C2A8BEA31342E8EC8241AF202`. It uses the existing Android debug certificate for local testing; production signing remains Gate D/Milestone 8.
- User acceptance completed: read-only login inspection, explicit initialization/existing-v2 join, Windows↔Android polling convergence, offline edits, Pause/Resume, force-stop/reopen, wrong-account safety, and owned `sync_v2_*` rows passed before Milestone 5 began.

## Milestone 5 — Android lifecycle, Realtime, and durable recovery

**Prerequisite:** Milestone 4. **Likely files:** `src/sync-v2/realtime.ts`, a focused platform lifecycle adapter, `src/main.ts`, lifecycle tests.

1. Prove whether Android Activity background/foreground is represented reliably by the current DOM focus/visibility events. If not, add a narrow Tauri lifecycle bridge; do not add a background service.
2. Make lifecycle transitions serialized and idempotent. Foreground startup order is authenticate/bind → subscribe → cursor catch-up → push outbox → final pull. Never apply Realtime payloads directly.
3. Enable Android `realtimeSync` only after lifecycle proof. Keep exactly one authenticated notebook channel and use Supabase's current callback-managed session so restored and refreshed JWTs are used.
4. Cancel any pending subscription before logout, account/notebook change, Pause, background, or stop. Resume must create a fresh connection, recreate a missing worker/manager, show an immediate transient status, and reach a bounded success or explicit failure—not spin forever.
5. On foreground/network return, subscribe before catch-up. Coalesce socket events; keep periodic foreground pulls when Realtime or WSS is blocked/degraded.
6. Backgrounding stops channels and polling after local SQLite work finishes. A best-effort sync request is allowed, but correctness relies on the persisted outbox. A force-stopped app does not sync until reopened; reopening must restore the session and catch up without logout/login.
7. Survive force-stop at local commit, outbox save, request, server accept, acknowledgement, delta apply, cursor save, subscription, and token refresh boundaries.
8. Keep editing enabled while offline/auth-failed. Show only `Syncing…`, `Offline`, `Sync failed`, or `Paused`; detailed causes stay behind the information control.

**Verify:** clean close/reopen while still signed in, Home/resume, rotation, offline edits, network switching, blocked/dropped WSS, token refresh, repeated rapid Pause/Resume, logout, process kill, and restart catch-up. Prove no duplicate channel, stale connect promise, duplicate/recreated record, lost acknowledged edit, tombstone resurrection, infinite retry, or close-event dependency.

**Done when:** connected changes normally arrive within seconds, while disabling Realtime changes latency—not correctness.

### Milestone 5 handoff

- Enabled Android `realtimeSync` while retaining periodic cursor pulls as the correctness path. Realtime payloads remain coalesced wake-ups; the worker performs subscribe → pull → push → final pull.
- Added `AppLifecycleCoordinator` and `RecordSyncExecutionController` to serialize native-focus, WebView-visibility, network, background, foreground, Pause/Resume, and stop transitions. Backgrounding removes the channel and polling; foregrounding shows `Syncing…`, creates one fresh channel, and catches up. Manual Pause cannot be undone by focus events.
- Added a 12-second subscription deadline. Silent, blocked, or failed WSS connections remove the stale channel, show an explicit failure, retain foreground polling, and retry with bounded backoff. No Supabase schema or migration changed.
- Changed files: `src/main.ts`, `src/platform/capabilities.ts`, `src/platform/lifecycle.ts`, `src/sync-v2/realtime.ts`, `src/sync-v2/runtime.ts`, `src/sync-v2/worker.ts`, focused tests, `AGENTS.md`, and this plan.
- Verification passed: TypeScript, 131 tests, production build, Rust format/check, secret scan, x86_64 debug APK, and optimized ARM64 APK. API 36/x86_64 emulator evidence covered Home/resume in the same process, native/DOM lifecycle signals, rotation, force-stop/reopen persistence, and an empty crash buffer.
- Emulator APK: `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`; SHA-256 `DF8B2393FAC69EF0C6005CD017A4CC61D5C98E479BC1A190F516EC7B9C5C69B9`.
- ARM64 optimized APK: `src-tauri/gen/android/app/build/outputs/apk/universal/release/Backlogger_0.1.0_android-arm64-m5.apk`; 17.16 MiB; SHA-256 `B222CFBBC3A9B850C6CE98E6AF21288BEE748BAE8D4B118E419E5BD996BB9E8A`. It uses the existing Android debug certificate for local testing; production signing remains Gate D/Milestone 8.
- Remaining user acceptance: with the same disposable account on Windows and Android, verify edits arrive both ways within seconds, Home/resume reconnects without login, rapid Pause/Resume settles, offline edits catch up, and a blocked socket still converges by polling. Milestone 6 may reuse the lifecycle/runtime interfaces but must not change sync semantics.

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
2. Repeat request/acknowledgement/cursor/socket/auth/process interruption cases, repeated close/reopen without re-login, update install, and reinstall/reconnect. Verify session restoration, outbox recovery, and one active channel.
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
- Google PKCE login handles warm/cold return, cancellation, close/reopen restoration without re-login, logout, and account mismatch without exposing secrets.
- Windows and Android share the SQLite repository and Supabase v2 record/OCC/cursor/Realtime protocol.
- Login is read-only; first initialization requires Start sync; routine conflicts reconcile automatically.
- Soft deletes prevent resurrection; offline outbox work and cursor application survive process death.
- Realtime is a foreground-only optimization with polling/cursor recovery, never the sole correctness mechanism; WSS/CSP or socket failure cannot block editing or restart catch-up.
- Import/export and mobile accessibility pass on a physical arm64 phone.
- Platform versions remain independent; Windows identifier and app-data location remain unchanged.
