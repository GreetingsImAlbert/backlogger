# Android implementation plan — Supabase sync

Status: revised after the Windows 0.1.3 Supabase release. This is the single Android planning document; it includes workstation setup, user gates, implementation details, verification, and release criteria.

Backlogger remains one Tauri 2 repository with a shared TypeScript/CSS frontend and shared Rust host. Windows and Android have independent release versions. Android must remain fully usable in local-only mode without an account or hosted service.

## Current baseline

- Milestone 1 is complete: the Android shell builds, installs, launches, and persists local notebook data through the native app-data commands.
- Milestone 2 is complete and superseded by the Windows Supabase migration: sync protocol logic is separated from transport I/O, `SupabaseSyncTransport` is the only active transport, and schema-1/2 folder locations exist only for safe migration/disconnection.
- Windows 0.1.3 has working optional Supabase sync through Google login, explicit Fetch/Merge recovery, durable pending publication, immutable snapshots, manifest CAS, retention, and session restoration.
- Android currently reports `cloudSync: false` and `supabaseSync: false`. Do not enable either until the applicable milestone verifies its behavior.
- Android document import/export is still disabled. Local create, edit, reorder, delete, theme, dates, deadlines, autosave, backups, and recovery must continue working throughout the remaining milestones.
- The generated `src-tauri/gen/` tree remains ignored. Do not commit build output, machine paths, tokens, keystores, or passwords.

## Instructions for every assigned agent

1. Implement only the assigned milestone. Read this entire document, `AGENTS.md`, the current code, and all earlier milestone handoffs before editing.
2. Treat listed paths as likely touch points, not permission to recreate or replace files blindly. Preserve unrelated work and existing Windows behavior.
3. Do not change `local.backlogger.desktop`, the Windows app-data location, the Windows-only version override, the sync protocol, or the Supabase database contract unless the milestone explicitly requires it.
4. Complete deterministic tests first. Never claim emulator-, provider-, or physical-device verification from mocks or compilation alone.
5. Do not run Supabase migrations, resets, links, pushes, or database tests. The user performs all Supabase operations manually under `AGENTS.md`.
6. Do not create Git commits. The user commits manually.
7. If interactive Google login, consent, a device prompt, a secret, or destructive cloud action is required, stop at that exact step and give the user explicit instructions. Never request passwords, MFA codes, OAuth codes, access/refresh tokens, client secrets, or signing passwords.
8. After implementation, append a concise `### Milestone N handoff` beneath the milestone. Record changed files, exact commands/results, APK/AAB paths, emulator/device serial, implemented versus actually tested behavior, user actions still required, and the next milestone's stable interfaces.

## Non-negotiable architecture and safety rules

- Local app data is authoritative for immediate editing. Network or authentication failure never blocks local use.
- Use the existing `@supabase/supabase-js` client, Google browser OAuth, schema-3 `SupabaseLocation`, `SupabaseSyncTransport`, and `SyncCoordinator`. Do not add a native Supabase SDK or another sync transport without a demonstrated blocker and explicit approval.
- Supabase Auth owns the persisted session. Tokens never enter notebook exports, sync snapshots, sync state, logs, UI messages, or repository files.
- Vite environment values are bundled into the APK. Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are allowed. Never bundle the Supabase service-role key, Google client secret, database password, signing key, or private token.
- Keep the PKCE flow and strict callback validation. A callback is accepted only for `backlogger://auth/callback`, while a fresh unexpired flow is pending, and only once.
- A Google login identifies one Supabase user. RLS and RPC ownership rules remain the security boundary; email addresses are display-only and never database ownership keys.
- Signing in alone must not upload anything. The user must explicitly start sync or explicitly choose Fetch/Merge when required.
- Preserve stable notebook/category/task IDs, snapshot immutability, complete ancestry validation, concurrent heads, pending work, content-deduplication, manifest CAS retries, checkpoints, and retention safeguards.
- Missing/invalid remote data, an expired session, offline state, or a different account never means an empty notebook and never authorizes deletion or overwrite.
- Android must not depend on a desktop close event. Persist the notebook and pending intent before network work; background publication is best-effort only.
- Do not add WorkManager, a foreground/background service, push notifications, or Supabase Realtime in the first Android release. Foreground, resume, explicit checks, and a durable local queue are the reliability boundary.
- Portable import/export excludes credentials, device identity, transport bindings, sync state, pending publications, and local UI preferences not already part of the portable schema.

## Integrated user setup gates

### Gate A — Android toolchain (complete; reverify when needed)

This workstation has already produced x86_64 Android debug APKs. Before a new agent diagnoses a build failure, verify the current environment instead of reinstalling blindly:

```powershell
& "$env:JAVA_HOME\bin\java.exe" -version
node --version
npm.cmd --version
rustup target list --installed
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices -l
& "$env:ANDROID_HOME\emulator\emulator.exe" -list-avds
Test-Path -LiteralPath $env:NDK_HOME
```

Expected: Java/Node/npm print versions; `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, and `x86_64-linux-android` are installed; the NDK path exists; and a booted emulator appears as `device` rather than `offline` or `unauthorized`.

If tooling must be repaired, Android Studio's SDK Manager needs a current Android SDK Platform, Build Tools, Platform Tools, Command-line Tools, Emulator, and NDK (Side by side). Keep `JAVA_HOME`, `ANDROID_HOME`, and `NDK_HOME` as user-level variables and fully restart Codex after changing them. Windows Developer Mode must remain enabled for Tauri's native-library symlinks.

### Gate B — hosted Supabase mobile callback (required for Milestone 3 real login)

The existing Supabase project and existing Google provider configuration are reused. The planned browser OAuth flow does **not** require a new Google Cloud project, new Google consent screen, or Android OAuth client.

The user must verify these non-secret settings:

1. In Supabase Dashboard → Authentication → URL Configuration, add the exact redirect URL `backlogger://auth/callback` to the allow list. Keep the Windows loopback callback already in use.
2. Confirm Google remains enabled in Supabase Authentication Providers and that Windows login still works. Do not copy the Google client secret into this repository.
3. Keep the development project's public URL and publishable key in `.env.local` using the names from `.env.example`.
4. Boot a Google Play-enabled Android emulator with Chrome or another browser capable of completing Google login.
5. The user completes account selection/consent personally during the first emulator login.

If the implementation later switches to native Google Identity Services, stop and revise this gate first; that is a different design and is not authorized by this plan.

### Gate C — disposable cloud acceptance (required before broad sync testing)

Use a development Supabase project and disposable test account/data for destructive, interruption, retention, and concurrency tests. Do not use a production user as an automated fixture.

The user must:

1. Confirm the development project contains the current migrations, RLS policies, grants, and RPCs.
2. Run the manual local/linked Supabase checks required by `AGENTS.md` if the database contract changed. No mobile-specific migration is expected.
3. Complete the first interactive Google login on both the Windows test profile and Android emulator using the same disposable account.
4. Approve any account chooser or browser-to-app prompt. Never paste credentials or callback codes into Codex.

### Gate D — current-user cloud safety (required before testing real Backlogger data)

Before the Android build connects to the user's existing cloud notebook:

1. Export the current Windows notebook to JSON and verify the export opens.
2. Let Windows finish any pending sync and record its current notebook ID, manifest version, heads, snapshot count, and local revision without exposing task contents.
3. Preserve a cloud/database export or provider backup containing that user's `sync_notebooks` and `sync_snapshots` rows outside the repository when available.
4. Verify Android first performs read-only inspection and reports the same notebook identity before Start sync, Fetch, or Merge is allowed.
5. Authorize controlled real-data writes only after disposable-project tests pass.

### Gate E — Android release identity and signing (required for Milestone 8)

- Keep application identifier `local.backlogger.desktop` unless the user explicitly authorizes a migration plan.
- The user creates and backs up the release keystore and passwords outside the repository.
- Signing configuration must read external environment/Gradle properties that are ignored by Git.
- Connect a physical Android phone and approve its USB/wireless debugging prompt.
- A Play Console account is required only for Play Store submission, not for a directly distributed signed APK.

## Standard commands and evidence

Run the commands relevant to every changed layer:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run security:secrets
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
npm.cmd run android:build
```

`npm.cmd run android:build` currently produces an x86_64 debug APK for the emulator. When shared Rust/Tauri configuration or code bundled into Android changes, rebuild and install it rather than reporting only a frontend build.

Typical emulator commands:

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices -l
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r "src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
& "$env:ANDROID_HOME\platform-tools\adb.exe" shell am force-stop local.backlogger.desktop
& "$env:ANDROID_HOME\platform-tools\adb.exe" logcat -c
```

Every emulator acceptance handoff should include the APK path/hash, device serial/API/ABI, install and launch result, relevant screenshots/UI tree, filtered `logcat`, and exact actions. Compilation alone is not runtime evidence.

## Completed Milestone 1 — Android shell and native local persistence

Retain this baseline; do not redo it unless a regression is found.

- Shared Tauri `run()` entry point and Android project initialization are complete.
- Android and Windows build from the same repository while Windows retains its independent version override.
- Android native local saves, backup/recovery behavior, responsive layout, and x86_64 emulator packaging have passed prior checks.
- Android sync and document import/export remain capability-gated.

## Completed Milestone 2 — Shared sync foundation and Supabase cutover

The old folder/OneDrive milestone is obsolete. The current baseline is:

- `src/sync/transport.ts` exposes only the Supabase transport kind.
- `src/sync/supabase-transport.ts` implements account/project binding, immutable snapshots, manifest CAS, pagination, error mapping, and guarded deletion.
- `src/sync/coordinator.ts` owns provider-neutral ancestry, reconciliation, pending publication, retry, and retention behavior.
- `src/sync.ts` schema 3 accepts Supabase locations only. Schema-1/2 folder values are migration input only and are disconnected without provider access.
- Windows acceptance has covered Google login, session restoration/logout, Fetch/Merge, offline and interrupted publication, deduplication, concurrent heads, and recovery.

## Milestone 3 — Android Google login and deep-link return

**Prerequisites:** Completed Milestones 1–2 and Gate B. No database migration should be needed.

**Likely files:** `src/supabase/auth.ts`, `src/supabase/config.ts`, `src/platform/capabilities.ts`, `src/main.ts`, `src-tauri/tauri.conf.json` or Android override, generated Android manifest inputs only where Tauri configuration cannot express the requirement, auth tests.

### Implementation

1. Configure Tauri's deep-link plugin for a mobile custom scheme `backlogger` with no app-link verification. Preserve the existing desktop scheme and the exact callback route `backlogger://auth/callback`.
2. Split OAuth redirect selection by runtime:
   - Windows Tauri continues using `start_oauth_callback_listener()` and the loopback completion page.
   - Android uses `backlogger://auth/callback` directly and must never invoke the Windows loopback-listener command.
   - Browser preview remains local-only and must not pretend mobile auth works.
3. Preserve `skipBrowserRedirect`, PKCE, `openid email profile`, the pending-flow marker, one-time code handling, strict callback validation, and sanitized errors. Continue using the system browser through the Tauri opener.
4. Receive callbacks when Android is already running, backgrounded, and launched cold. Use `onOpenUrl` where supported and a narrow Android/native fallback if the Tauri API does not deliver cold-start URLs. Do not weaken callback validation to make routing pass.
5. On callback, return focus to Backlogger, exchange the code once, restore the Supabase session, refresh the Sync dialog immediately, and leave the browser page in a completed/closable state when possible.
6. Handle account chooser cancellation, closing the browser without completing, expired callback codes, duplicate callbacks, offline exchange, and process death during PKCE. Returning to the app must expose Cancel/retry rather than remain indefinitely in `Signing in`.
7. Keep remote publication disabled during this milestone. If the existing capability model cannot expose authentication without enabling sync writes, add the smallest explicit auth capability or test-only read guard; do not temporarily enable unrestricted Start sync.

### Verification

- Unit-test runtime redirect selection, strict URL parsing, pending-flow expiry, duplicate callback rejection, cancellation, and sanitized errors.
- Use `adb shell am start -W -a android.intent.action.VIEW -d "backlogger://auth/callback?..."` to prove intent routing; a forged callback without a pending verifier must be rejected safely.
- With the user, complete a real Google login on the emulator. Verify warm, background, and cold-start return; session restoration after force-stop; logout; login cancellation; and wrong-account rejection.
- Inspect app storage exposed through normal debugging, logs, UI, Git diff, and APK secret scan. No token, Google secret, or service-role key may appear.

**Done when:** Android can complete and restore browser-based Google authentication reliably, logout keeps the local notebook, cancellation recovers without restart, and sync publication is still blocked.

## Milestone 4 — Enable the existing Supabase transport on Android

**Prerequisites:** Milestone 3 provider-tested login and Gate C. Use disposable cloud data first.

**Likely files:** `src/platform/capabilities.ts`, `src/main.ts`, `src/sync/coordinator.ts`, `src/sync/supabase-transport.ts`, focused tests. Do not introduce Kotlin database transport code.

### Implementation

1. Confirm Android WebView can call the configured `https://<project-ref>.supabase.co` endpoint under the current CSP/network configuration. Keep local-only behavior when environment configuration is absent or invalid.
2. Enable Android `cloudSync`/`supabaseSync` only after authentication and transport initialization pass. Reuse the exact Windows `SupabaseLocation`, transport, coordinator, RLS, and RPC contract.
3. Signing in performs account/cloud inspection only. It must not create a notebook, publish local data, or replace local data.
4. For an empty account, Start sync may initialize the user's cloud notebook only after explicit action. For an existing cloud notebook, show the same explicit Fetch and Merge choices before publication when histories differ.
5. Keep Fetch as validated local replacement with backup/recovery. Keep Merge as the deterministic union already used on Windows. No new conflict-resolution UI is in scope.
6. Preserve content fingerprint deduplication: unchanged task/category content must not create another snapshot.
7. Preserve sanitized auth, RLS, offline, rate-limit, conflict, invalid-data, and server error handling. A failed request keeps local edits and pending work recoverable.
8. Keep one serialized sync mutation queue. Never publish to a different user/project binding or infer ownership from email.

### Verification

- Run existing transport/coordinator tests unchanged and add Android capability/configuration coverage.
- Against the disposable project, verify: signed-out local editing; login with no automatic writes; empty-cloud initialization; existing-cloud discovery; Fetch; Merge; unchanged-content deduplication; sequential Windows→Android and Android→Windows publication; concurrent heads; offline error; logout; and restart.
- Inspect Supabase rows to confirm ownership, immutable snapshot payloads, increasing manifest versions, and no cross-user access. The user performs database inspection and CLI tests.

**Done when:** The emulator and a disposable Windows profile using the same Google account converge through the existing Supabase protocol without data loss or automatic first-login publication.

## Milestone 5 — Android lifecycle and durable foreground sync

**Prerequisite:** Milestone 4.

**Likely files:** `src/main.ts`, `src/sync/coordinator.ts`, platform lifecycle module, Android/Tauri lifecycle bridge only if web visibility events are insufficient, lifecycle tests.

### Implementation

1. Save every committed edit locally immediately and persist pending publication state before network requests.
2. On Android launch, resume, reconnect, and explicit Check for updates, inspect remote history before allowing stale pending work to publish.
3. Suspend polling while backgrounded and restart it once on foreground resume. Prevent overlapping timers, auth inspection, or sync cycles.
4. Coalesce rapid local edits into one full snapshot after the existing idle/debounce window while the app is foregrounded and online.
5. On background transition, request a best-effort publication only after local persistence completes. Correctness must not depend on the request finishing.
6. Recover safely after process termination at every boundary: before snapshot RPC, after snapshot creation/before manifest CAS, after CAS/before local state save, and during cleanup.
7. Restore login, pending-flow, pending-snapshot, paused state, and error state coherently. Local controls must not remain greyed out while authenticated or offline.
8. Keep status text simple (`Syncing…`, `Offline`, `Sync paused`, actionable errors) and expose detailed operation text through the existing accessible information control.

### Verification

- Force-stop/kill after edits and at each publication boundary; restart online and offline.
- Exercise Home/resume, screen rotation, network disable/enable, rapid edits, revoked/expired auth, browser cancellation, pause/resume, logout, and account change with pending data.
- Confirm no edit loss, duplicate publication, stale overwrite, permanent disabled UI, overlapping loop, or dependence on a close callback.

**Done when:** Android survives ordinary mobile lifecycle interruption and reconnects through its durable local queue without requiring a background service.

## Milestone 6 — Android document import/export and mobile UX

**Prerequisite:** Milestone 5. This milestone must not change sync semantics.

**Likely files:** `src/platform/documents.ts`, `src/main.ts`, `src/style.css`, Tauri dialog/filesystem capabilities, a narrow Kotlin stream bridge only if required, document tests.

### Implementation

1. Implement Android import/export through the system document picker and content URI streams. Do not pass content URIs to Rust functions that assume filesystem paths.
2. Import reads text, validates the complete portable notebook, previews/requires confirmation, backs up the current local notebook, then replaces it. Cancellation is neutral and malformed/future-schema input leaves local data unchanged.
3. Export writes the portable notebook only and reports success after the output stream closes successfully. It excludes credentials and sync/device metadata.
4. Enable `documentImportExport` only after real emulator round-trip verification. Remove placeholder disabled messaging only for completed capabilities.
5. Finish safe-area padding, touch targets, small-screen dialogs, keyboard avoidance, portrait/landscape behavior, dark/light themes, font scaling, TalkBack labels, and focus restoration.
6. Verify long-press/pointer task and category reordering does not fight vertical scrolling. Keep Move up/down as the accessible fallback and task movement within its category.
7. Keep Sync settings consistent with Windows: Google account, Start sync, Check for updates, Pause/Resume, Fetch/Merge where applicable, Log out, and one Close action.

### Verification

- Round-trip a representative JSON export through Android's document provider and re-import it.
- Test picker cancellation, denied/revoked access, unwritable destinations, malformed JSON, unsupported schema, process interruption, and recovery backup.
- Exercise keyboard, rotation, smallest supported viewport, theme, font scaling, TalkBack, touch reordering, and scroll behavior on emulator; record physical comfort checks as pending until Milestone 8.

**Done when:** Android local documents and the full mobile UI work without raw-path assumptions, data loss, inaccessible controls, or desktop regressions.

## Milestone 7 — Two-client and current-data acceptance

**Prerequisites:** Milestones 3–6, all disposable tests passing, and Gate D before current-user data.

### Acceptance sequence

1. Re-run the complete repository, Rust, security, Windows packaging, and Android packaging checks.
2. With disposable data, verify two isolated clients have distinct device IDs but the same Supabase account/notebook.
3. Test first initialization, explicit second-client Fetch, edits in both directions, concurrent offline edits followed by Merge, restart recovery, and content deduplication.
4. Interrupt every publication boundary and retention cleanup. Verify immutable rows do not change, manifest versions increase, both branches survive, and pending work recovers.
5. Test expired/revoked auth, login cancellation, wrong account, logout, offline startup, throttled/transient failures, pause/resume, process kill, and return online.
6. Verify a different Supabase user cannot query/mutate the first user's notebook or snapshots. The user performs the relevant pgTAP/linked checks and database inspection.
7. After Gate D, sign into the current account on Android and perform read-only inspection first. Confirm account ID binding, notebook ID, manifest version/heads, and visible task/category content agree with Windows.
8. After explicit authorization, make small controlled edits Windows→Android and Android→Windows, then one offline independent-edit Merge. Verify actual notebook contents on both clients and preserve the backups.
9. Inspect local app data, portable exports, logs, Git diff, APK, executable, and installer with the secret scanner.

**Done when:** Both clients converge without data loss through sequential, concurrent, offline, auth, interruption, and restart cases; current-user validation passes; RLS isolation is confirmed; and Windows 0.1.3 behavior remains intact.

## Milestone 8 — Signed Android release and regression

**Prerequisites:** Milestone 7, Gate E, final Android version chosen by the user, and a physical phone. Play Console is optional.

### Implementation

1. Add external release-signing configuration without committing the keystore, aliases, paths, passwords, or generated signed artifacts.
2. Keep Android version independent from `tauri.windows.conf.json`. Update only the Android/shared fields deliberately selected for this release.
3. Add repeatable commands for an arm64 release APK and release AAB. Release builds must contain the production Supabase public configuration and must reject test-only configuration paths.
4. Build, hash, and install the signed APK on the physical phone. Build/hash the AAB if store distribution is planned.
5. Repeat local persistence, forced termination, Google login/session restore/logout, two-way sync, offline Merge/recovery, document import/export, rotation, keyboard, touch, font scaling, and TalkBack checks on the phone.
6. Rebuild and smoke-test the Windows installer. Confirm the Windows-only version and existing app-data location are unchanged.
7. Update README/release documentation with Android prerequisites, install/update instructions, optional sync behavior, public configuration, signing without secrets, foreground-sync limits, recovery/export guidance, artifact names, and hashes.

**Done when:** A signed arm64 APK installs and passes physical-device acceptance, the AAB is reproducible if required, secret scans pass, Windows regression passes, and all artifact paths/hashes are recorded.

## Test ladder — never skip upward

1. Pure unit tests: dates, storage, migration, auth callback, transport, coordinator, ancestry, Merge, retention, and failure recovery.
2. Mock Supabase tests: auth loss, RLS denial, pagination, immutable collision, manifest CAS race, transient failures, interruption, and two clients.
3. Android local emulator: install, launch, editing, persistence, force-stop, rotation, keyboard, touch, and offline local mode.
4. Android auth emulator: intent routing, browser return, cancellation, warm/cold callback, session restore, and logout.
5. Disposable hosted Supabase: read/write, Windows/emulator convergence, concurrency, lifecycle, retention, and security isolation.
6. Current-user read-only inspection, followed by explicitly authorized controlled two-way writes.
7. Signed physical device: complete local, sync, documents, accessibility, and recovery pass.

## Final Android release criteria

- The signed arm64 APK installs and runs on a supported physical Android device.
- Local-only use requires no login, network, or hosted service and survives restarts/forced termination.
- Google browser login returns reliably to the app, uses PKCE, restores sessions, handles cancellation, and exposes no credentials.
- Android and Windows use the same Supabase notebook/snapshot/manifest contract with RLS ownership isolation.
- Login never publishes automatically; Fetch/Merge and Start sync remain explicit where data could be replaced or joined.
- Snapshot writes are immutable, unchanged content is deduplicated, manifest writes use CAS, and interrupted/offline work remains recoverable.
- Android lifecycle behavior does not depend on a close event or background service.
- Import/export uses Android document providers safely and excludes device/sync/auth state.
- Touch, keyboard, rotation, themes, font scaling, TalkBack, and reordering pass on the physical phone.
- Android and Windows release versions remain independent; the Windows identifier and app-data path remain unchanged.
- No service-role key, Google client secret, access/refresh token, database password, keystore, or signing password is tracked or bundled.

## Primary references

- [Supabase native mobile deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase PKCE flow](https://supabase.com/docs/guides/auth/sessions/pkce-flow)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Tauri deep linking](https://v2.tauri.app/plugin/deep-linking/)
- [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android)
- [Tauri Google Play distribution](https://v2.tauri.app/distribute/google-play/)
- [Android custom deep links](https://developer.android.com/training/app-links/deep-linking)
