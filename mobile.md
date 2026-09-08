# Backlogger Android and OneDrive build plan

Status: planned. This document covers an Android build in the existing Backlogger repository and synchronization with the existing OneDrive folder named `backlogger-sync`.

## 1. Goal

Add an Android version without forking the product or duplicating its domain logic. The Android app must:

- Preserve all local category, task, date, deadline, ordering, theme, import, export, backup, and recovery behavior that makes sense on a phone.
- Save locally first and remain fully usable without a network connection or Microsoft account.
- Sync through Microsoft Graph with the same OneDrive data already used by the Windows build.
- Read and write the existing sync protocol and history without migrating, copying, or resetting it.
- Preserve the current Windows release behavior. Windows may continue accessing OneDrive through the locally synchronized filesystem while Android accesses the same cloud folder through Microsoft Graph.

This is a same-repository, shared-code implementation. A separate Android repository is explicitly not planned.

## 2. Fixed decisions and boundaries

- Target Android with Tauri 2 and the existing TypeScript/CSS frontend.
- Support OneDrive only. Google Drive, other providers, a Backlogger-hosted server, iOS, collaboration between different Microsoft accounts, and continuous background sync are out of scope.
- Use the signed-in user's default OneDrive and the existing folder at `/backlogger-sync` relative to that drive's root in production.
- Use a debug-only `/backlogger-sync-test` override for destructive development and emulator testing. Release builds must ignore this override and always target `/backlogger-sync`.
- Do not use OneDrive's special `Apps/<app name>` app folder because that would be a different location from the folder already used by the desktop app.
- Do not create `backlogger-sync/backlogger-sync`. The current Windows code accepts the selected parent directory and appends `backlogger-sync`; the Android transport instead treats the existing OneDrive `/backlogger-sync` item itself as the sync root.
- Do not move, rename, replace, or initialize the existing production folder during first connection. The first Android connection must find it, read `notebook.json`, validate the notebook and snapshot history, and ask for user action if anything is missing or invalid. A debug build may initialize `/backlogger-sync-test` only after explicit confirmation.
- Keep the cloud directory as an exchange history, not the live local database. Each device retains its own local notebook, backup, device ID, pending snapshots, and sync state.
- Preserve the current sync protocol unless an independently versioned protocol change is necessary. Theme, selected view, access tokens, account identity, and device settings never enter shared snapshots.

## 3. Canonical shared layout

The cloud layout remains exactly:

```text
OneDrive root/
  backlogger-sync/
    notebook.json
    snapshots/
      <snapshot-id>.json
```

Windows should continue to be configured with the **OneDrive root as its selected parent folder**, producing `<OneDrive root>/backlogger-sync/...` through the existing path helpers. Android should resolve `/backlogger-sync` through Microsoft Graph and store the returned drive ID and folder item ID in device-local sync state.

Before Android development or live testing, make a manual backup copy of the entire existing `backlogger-sync` folder. Tests must never point at this live folder until all mock and isolated-folder checks pass.

Debug cloud tests use a separate root-level folder:

```text
OneDrive root/
  backlogger-sync-test/
    notebook.json
    snapshots/
```

The test-folder name must be injected through debug configuration rather than hard-coded into protocol logic. The UI must always display the active remote folder clearly. Production/release builds must reject any test-folder override.

## 4. Permission and authentication model

### Required permission

Accessing an existing arbitrary root folder requires the delegated Microsoft Graph `Files.ReadWrite` permission. `Files.ReadWrite.AppFolder` is narrower, but it only grants access to the application's special OneDrive app folder and therefore cannot be used with the existing `/backlogger-sync` location.

The consent screen must honestly explain that Microsoft describes `Files.ReadWrite` as full access to the signed-in user's files, even though Backlogger will deliberately address only `/backlogger-sync`. If this permission is unacceptable later, the migration option is to move sync into the special app folder; that is not part of this plan.

### App registration

Create one Microsoft Entra public-client application configured for personal Microsoft accounts and, if desired, work or school accounts. Register the Android package name and signing-certificate hash before testing authentication. Finalize the production Android identifier and signing key before publishing because they participate in the redirect configuration.

Use Microsoft's supported MSAL Android library in single-account mode:

- Interactive sign-in for the first connection.
- Silent token acquisition for normal sync.
- Authorization-code flow with PKCE as handled by MSAL.
- No client secret in the app. A mobile app is a public client and cannot protect one.
- Never expose access or refresh tokens to the TypeScript layer, write them into Backlogger JSON, include them in logs, or commit them to the repository.
- Let MSAL own its token cache. The native bridge exposes account state and OneDrive operations, not raw credentials.

Sign-out disconnects OneDrive but does not delete the locally saved notebook or pending local work. Signing into a different Microsoft account must not publish existing pending work automatically; require an explicit confirmation after locating and validating that account's `/backlogger-sync` folder.

## 5. Architecture

### Shared sync protocol, replaceable transport

Separate the existing ancestry, merge, conflict, retention, and session rules from filesystem I/O. Introduce a transport contract similar to:

```ts
interface SyncTransport {
  readonly kind: 'local-folder' | 'onedrive';
  connect(): Promise<RemoteNotebookLocation>;
  readManifest(): Promise<VersionedRemote<SyncManifest> | null>;
  writeManifest(
    manifest: SyncManifest,
    expectedVersion: string | null,
  ): Promise<VersionedRemote<SyncManifest>>;
  listSnapshots(): Promise<RemoteSnapshotEntry[]>;
  readSnapshot(entry: RemoteSnapshotEntry): Promise<SyncSnapshot>;
  createSnapshot(snapshot: SyncSnapshot): Promise<'created' | 'already-identical'>;
  deleteSnapshot(entry: RemoteSnapshotEntry): Promise<void>;
}
```

Implement two adapters:

- `LocalFolderSyncTransport`: wraps the current Tauri filesystem commands and retains Windows behavior.
- `OneDriveSyncTransport`: invokes native Android commands backed by MSAL and Microsoft Graph.

Keep protocol operations such as manifest validation, ancestry discovery, checkpoint creation, conflict merging, pending publication, and retention above this interface. They must not know whether data arrived through a Windows path or a Graph drive item.

### Platform separation

Replace the current binary `desktop`/`browser` assumption with an explicit platform capability model:

```ts
type AppPlatform = 'browser' | 'windows' | 'android';

interface PlatformCapabilities {
  nativeLocalStorage: boolean;
  nativeDocumentPicker: boolean;
  localFolderSync: boolean;
  oneDriveSync: boolean;
  closeRequest: boolean;
  mobileLifecycle: boolean;
}
```

Suggested code organization:

```text
src/
  platform/
    capabilities.ts
    documents.ts
  sync/
    protocol.ts
    coordinator.ts
    transport.ts
    local-folder-transport.ts
    onedrive-transport.ts
src-tauri/
  src/
    lib.rs
    main.rs
  gen/android/
  tauri.windows.conf.json
  tauri.android.conf.json
```

The exact file split can remain smaller if that makes the code clearer, but platform checks must not stay scattered throughout the UI.

### Native Android bridge

Add a small Tauri Android plugin written in Kotlin. It should own:

- MSAL initialization, sign-in, silent token acquisition, account display, and sign-out.
- Authenticated Microsoft Graph requests.
- Downloading file content while following Graph's content redirect safely.
- Android lifecycle notifications needed by the TypeScript sync coordinator.
- Stable, sanitized errors such as `sign-in-required`, `folder-not-found`, `permission-denied`, `offline`, `throttled`, `version-conflict`, and `remote-invalid`.

Keep notebook and sync-protocol validation in the existing shared TypeScript layer. Native code transports bytes and metadata; it does not decide which notebook version wins.

## 6. OneDrive Graph mapping

### Connection and discovery

1. Acquire a token silently or perform interactive sign-in.
2. Resolve `GET /me/drive/root:/backlogger-sync`.
3. Confirm that the returned item is a folder.
4. Save the account's stable local MSAL identifier plus the OneDrive drive ID and `backlogger-sync` item ID in device-local sync state.
5. Read `notebook.json` and list the `snapshots` child folder by item ID after discovery. Prefer IDs for ongoing calls so a later user rename is detected explicitly rather than silently targeting a newly created path.
6. Validate the manifest, notebook ID, protocol version, snapshot records, and required ancestry before enabling publication.

An absent folder, manifest, or snapshots directory is not an empty notebook. Show an actionable error and leave local data untouched. Initial folder creation remains a separate future decision.

### Reading

- List children using Graph's children endpoint and follow every `@odata.nextLink`; never assume one page contains all snapshots.
- Filter candidates by the exact `.json` naming rules, but validate file contents independently of names and provider timestamps.
- Download content through the native HTTP layer. Do not cache Graph's short-lived download URLs.
- Treat `404`, malformed JSON, duplicate IDs with different content, missing parents, and notebook-ID mismatches as safety errors, never as deletion or an empty remote notebook.
- Use timestamps only for display. Ancestry determines ordering.

### Immutable snapshot creation

- Upload each snapshot under `snapshots/<snapshot-id>.json`.
- Use create-with-conflict-failure semantics when available; never permit OneDrive's default replacement behavior to overwrite a snapshot silently.
- If the name already exists, download and validate it. Return `already-identical` only when its parsed content is exactly the intended immutable snapshot. Different content under the same ID is a hard sync error.
- Record a pending publication locally before making the network request. Remove it from the queue only after the remote item is confirmed.

### Manifest updates and concurrency

`notebook.json` is mutable and therefore needs optimistic concurrency:

1. Read the current manifest and its Graph `eTag`.
2. Revalidate the notebook ID, heads, pruned IDs, and referenced snapshots.
3. Calculate the next manifest without discarding heads published by another device.
4. Upload with an `If-Match` precondition against the observed version.
5. On `412 Precondition Failed`, fetch the new manifest, reconcile again, and retry a bounded number of times.
6. If safety cannot be established, keep the local snapshot pending and show a retryable conflict/error. Never issue an unconditional last-writer-wins overwrite.

The implementation spike must verify the chosen Microsoft Graph upload endpoint's conditional-write behavior against both personal OneDrive and any work/school account type claimed by the app before live-folder use.

### Retention

Reuse the current 30-snapshot checkpoint and pruning rules. Delete by remote item ID only after the replacement checkpoint and manifest are confirmed. A `404` during deletion is idempotent; permission, throttling, or server failures stop cleanup without affecting the usable notebook. Retention remains best-effort and must never delete unresolved heads, required ancestry, or pending publications.

### Throttling and network behavior

- Serialize sync cycles per device.
- Apply bounded timeouts to each request and the overall foreground sync attempt.
- Honor Graph `Retry-After` responses and use jittered exponential backoff for `429` and transient `5xx` responses.
- Refresh an expired token silently once. If interaction is required, retain pending work and show `Sign in again`.
- Do not retry malformed data, notebook mismatch, or permission loss as though they were transient connectivity failures.

## 7. Android local behavior and lifecycle

Local app-data storage remains authoritative for immediate saves. The existing Rust app-data commands should be made mobile-compatible and retain primary/temporary/backup validation.

Android cannot depend on a desktop close event: the process can be stopped without a final callback. Therefore:

- Save every committed edit locally immediately, as today.
- Persist pending sync state before attempting any upload.
- Fetch before allowing a stale pending snapshot to publish after launch or reconnect.
- Check OneDrive at startup, on foreground resume, through `Check for updates`, and on the existing foreground polling interval.
- Suspend polling while backgrounded.
- After local changes, publish one coalesced full snapshot after a short idle/debounce period while online. Also attempt publication when the app enters the background, but never depend on that attempt completing.
- Keep explicit `Sync now` and `Pause` controls.
- Do not add an Android background service or WorkManager job in the first release. Foreground/resume sync plus durable local queues is the initial reliability boundary.

The Windows close-time publication flow may remain unchanged. Both publication strategies produce the same immutable snapshot format.

## 8. Android UI and document handling

- Keep the same primary list and editor rather than designing a separate mobile product.
- Increase interactive controls to comfortable touch targets without making the list unnecessarily spacious.
- Add status-bar, navigation-bar, and display-cutout safe-area padding.
- Verify dialogs with the software keyboard, small screens, landscape, dark/light mode, font scaling, and TalkBack.
- Preserve pointer-based reordering, then test long-press/drag behavior and scrolling conflicts on a real touch screen.
- Replace desktop path-based import/export with Android document-picker operations over content URIs. Import still validates and previews before replacement; export reports success only after the document stream closes successfully.
- Show OneDrive states using plain labels: `Not connected`, `Signing in`, `Checking OneDrive`, `Shared update available`, `Saved locally`, `Offline`, `Sign in again`, and `Sync paused`.
- In Sync settings, show the signed-in account and fixed remote folder `OneDrive/backlogger-sync`. Do not offer an Android folder picker for this plan.

## 9. Tauri and Android build work

1. Install and verify Android Studio, SDK Platform, Platform Tools, Build Tools, command-line tools, NDK, Java, and the four Rust Android targets required by Tauri.
2. Run `npm run tauri android init` in this repository and review generated files before committing them.
3. Refactor the Tauri entry point into a reusable `run()` in `lib.rs`, annotated with Tauri's mobile entry point, while retaining the desktop `main.rs` launcher.
4. Move NSIS-only configuration into `tauri.windows.conf.json`; add Android bundle, minimum SDK, permissions, icons, and identifier configuration in `tauri.android.conf.json`.
5. Keep the single-instance plugin desktop-only. Enable only plugins that declare Android support on Android.
6. Add the Kotlin OneDrive/MSAL plugin and narrowly scoped Tauri permissions for its commands.
7. Add scripts and README instructions for Android development, emulator/device deployment, debug APK builds, release AAB builds, and signing.
8. Build and run on an emulator before using a real device or the live OneDrive folder.

Use the existing identifier for local development unless changing it is necessary to initialize Android. Choose an owned production reverse-domain identifier before Entra production registration or Play Store publication; record and test any app-data migration if the Windows identifier changes.

## 10. Windows workstation setup before implementation

### Current readiness snapshot

Checked on this Windows workstation on 2026-09-08:

| Component | Current state | Required action |
| --- | --- | --- |
| Android Studio | Installed under `C:\Program Files\Android\Android Studio` | Keep installed |
| Java | Android Studio JBR/OpenJDK 21 present | Set `JAVA_HOME` and restart Codex |
| Android SDK | Present under `%LOCALAPPDATA%\Android\Sdk` | Set `ANDROID_HOME` |
| SDK platform | Android 36.1 installed | Sufficient; retain at least one current stable platform |
| Build Tools | 36.0.0, 36.1.0, and 37.0.0 present | Sufficient unless generated Gradle requires a particular stable version |
| Platform Tools / `adb` | Installed | Add to `PATH` or call by absolute path |
| Android Emulator | Installed | A system image and virtual device are still required |
| SDK Command-line Tools | Not detected | Install **Android SDK Command-line Tools (latest)** |
| NDK | No side-by-side NDK detected | Install **NDK (Side by side)** |
| Emulator system image | None detected | Download one Google Play x86_64 phone image |
| Android Virtual Device | None configured | Create and boot one AVD |
| Rust | Installed for Windows | Add all four Android targets |
| Node.js | Available only through Codex's bundled runtime | Install/repair normal Node LTS so both `node` and `npm` are on `PATH` |
| `npm` | Not currently available in the Codex shell | Required before Tauri npm scripts can run |

Re-run this audit at implementation time because SDK contents and environment variables can change.

### User setup gate A — required before Android build work

Complete these steps before asking Codex to execute the Android implementation end to end.

1. Open Android Studio.
2. From the welcome screen choose **More Actions → SDK Manager**, or from an open project choose **Tools → SDK Manager**.
3. In **SDK Platforms**, keep a current stable Android SDK Platform installed. Android 36.1 is already present on this machine.
4. In **SDK Tools**, enable and apply:
   - Android SDK Build-Tools
   - Android SDK Platform-Tools
   - Android SDK Command-line Tools (latest)
   - Android Emulator
   - NDK (Side by side)
5. Accept the Android SDK/NDK license prompts. The default current NDK is appropriate unless Tauri's generated Gradle project pins another version.
6. Open **Device Manager → Create Device**. Choose a common Pixel phone profile and a current stable **Google Play x86_64** image, preferably API 35 or 36. Download the image when prompted, finish creating the AVD, and boot it once.
7. If the emulator cannot start, enable CPU virtualization in firmware and Windows Hypervisor Platform/Hyper-V as appropriate for this PC, then retry before implementation.
8. Install the current Node.js LTS release for Windows if `npm` remains unavailable. A normal system installation is preferable to relying on Codex's internal Node runtime.

Set the user-level environment variables after the NDK installation. Run this in a normal PowerShell window:

```powershell
$androidSdkPath = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$androidNdkDirectory = Get-ChildItem -LiteralPath (Join-Path $androidSdkPath 'ndk') -Directory |
  Sort-Object Name |
  Select-Object -Last 1

[System.Environment]::SetEnvironmentVariable(
  'JAVA_HOME',
  'C:\Program Files\Android\Android Studio\jbr',
  'User'
)
[System.Environment]::SetEnvironmentVariable('ANDROID_HOME', $androidSdkPath, 'User')
[System.Environment]::SetEnvironmentVariable('NDK_HOME', $androidNdkDirectory.FullName, 'User')
```

Add Rust's Android targets:

```powershell
rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android
```

Then fully quit and reopen Codex so it inherits the new environment. A new terminal tab alone may not update the desktop application's environment.

Verify the setup in the reopened Codex terminal or PowerShell:

```powershell
& "$env:JAVA_HOME\bin\java.exe" -version
node --version
npm --version
rustup target list --installed
& "$env:ANDROID_HOME\platform-tools\adb.exe" devices -l
& "$env:ANDROID_HOME\emulator\emulator.exe" -list-avds
Test-Path -LiteralPath $env:NDK_HOME
```

Expected result: Java, Node, and npm print versions; all four Android Rust targets appear; at least one AVD is listed; `Test-Path` returns `True`; and `adb devices` shows the booted emulator as `device` rather than `offline` or `unauthorized`.

### What is not required before coding starts

The Microsoft Entra registration, OneDrive login, production signing key, Play Console account, and physical phone are not required for the Android shell or transport refactor. The OneDrive Android app is also unnecessary because Backlogger will call Microsoft Graph directly. Do not delay milestones 1–2 for those items. They become gates only for the integration stages below.

## 11. OneDrive and release setup gates

### User setup gate B — required before real OneDrive authentication tests

After Codex creates the Android project and fixes the package identifier, the user must:

1. Create or open a Microsoft Entra app registration for Backlogger.
2. Configure it as a public client that permits the intended account types. For personal OneDrive, personal Microsoft accounts must be allowed; choose combined personal and organizational support only if both will actually be tested.
3. Add the Android platform configuration using the exact generated package name and debug signing-certificate hash.
4. Provide the application/client ID and non-secret redirect configuration to the project through the documented local configuration path.
5. Grant/approve delegated Microsoft Graph `Files.ReadWrite` when prompted. Review the broad permission wording before consenting.
6. Create an empty `/backlogger-sync-test` folder at the root of the same OneDrive account. Do not copy live snapshots into it. The debug app will initialize its own separate notebook there after confirmation.
7. Perform the first interactive Microsoft login inside the emulator personally. Do not paste a Microsoft password, one-time code, access token, refresh token, or recovery code into Codex or a project file.

Codex can continue automated sync testing after the interactive login because MSAL retains the authorized account/token state inside the emulator. If a later prompt requires credentials, testing pauses for the user to complete it.

### User setup gate C — required before touching live `/backlogger-sync`

1. Close Backlogger on Windows and allow pending local writes/publication to finish.
2. Confirm the Windows OneDrive client reports the folder as synchronized.
3. Copy the entire current `backlogger-sync` directory to a local archive **outside OneDrive** and keep it until Android acceptance is complete. A second copy inside OneDrive is not an independent backup.
4. Record or hash the original `notebook.json` and snapshot inventory so unintended writes can be detected.
5. Authorize a read-only live-folder validation first. Android must locate `/backlogger-sync`, validate the manifest and all required ancestry, and create no files.
6. Authorize live writes only after mock tests, `/backlogger-sync-test` tests, and read-only live validation pass.

### User setup gate D — required before release

- Choose the final owned reverse-domain Android application identifier.
- Create and securely back up the Android release keystore and passwords outside the repository.
- Add the release signing-certificate hash to the Entra Android platform configuration.
- Connect at least one physical Android phone using USB or wireless debugging and approve its RSA debugging prompt.
- Perform Microsoft sign-in and the full acceptance pass on that phone.
- Create a Play Console application only if Play Store distribution is wanted. It is not needed for a directly installed debug or signed APK.

## 12. How testing works from one Windows Codex workspace

The Android emulator is the second device. No second computer is required:

```text
Windows Backlogger
  ↕ local files managed by the Windows OneDrive client
OneDrive/backlogger-sync
  ↕ Microsoft Graph
Android emulator running on the same Windows PC
```

Codex can perform the CLI-driven portions from this repository:

- Run TypeScript, Rust, protocol, transport, and mock-Graph tests.
- Build the Android debug APK with Tauri/Gradle.
- Start or target the configured emulator, install/replace the APK, resolve its launch activity, and launch it through `adb`.
- Drive UI flows with `adb` taps, text, swipes, Back, rotation, force-stop, process restart, and network toggling.
- Derive tap coordinates from the Android UI tree rather than guessing from screenshots.
- Capture step-specific screenshots, UI hierarchies, application logs, and crash-buffer output.
- Verify app-data persistence across normal restart, force-stop, and process termination.
- Exercise the signed-in OneDrive session after the user completes interactive login.
- Run Windows → OneDrive → emulator and emulator → OneDrive → Windows exchanges on this one PC.

The user remains responsible for interactions Codex must not perform:

- Microsoft passwords, MFA, recovery codes, and consent decisions.
- Entra portal ownership and production registration choices.
- SDK license acceptance if Android Studio presents it interactively.
- Backing up and authorizing use of the live OneDrive folder.
- Approving a physical phone's debugging prompt and judging physical touch/keyboard comfort.
- Protecting release signing keys and passwords.

### Test ladder

Testing proceeds in this order and does not skip directly to the live folder:

1. **Windows unit tests:** protocol, storage, ordering, ancestry, merge, conflict, and retention behavior.
2. **Mock transport tests:** Graph pagination, redirects, auth expiry, throttling, `412` races, retries, corrupt content, and interrupted publication without any Microsoft account.
3. **Android local emulator tests:** install, launch, editing, autosave, backups, import/export, touch layout, rotation, offline mode, lifecycle, force-stop, and restart.
4. **Isolated OneDrive tests:** use only `/backlogger-sync-test`; verify authentication, Graph reads/writes, concurrency, and Windows/emulator exchange where useful.
5. **Live read-only validation:** inspect `/backlogger-sync` and compare its validated heads/inventory with Windows without writing.
6. **Live two-way acceptance:** after explicit authorization, publish controlled edits in both directions and test concurrent branches/conflicts.
7. **Physical-device acceptance:** install the signed build on a phone and repeat the critical local, lifecycle, OneDrive, accessibility, and touch flows.

For emulator QA, every test case should preserve evidence: build result, device serial, app version, action log, relevant UI-tree dump, screenshot, and filtered `logcat`. Record completed release-facing scenarios in the relevant milestone handoff in `mobile-implementation.md`.

## 13. Sync-state compatibility

Version the device-local sync state so old Windows state remains readable. Replace an untyped `folderPath` assumption with a transport-specific location, conceptually:

```ts
type SyncLocation =
  | { kind: 'local-folder'; parentPath: string }
  | {
      kind: 'onedrive';
      accountId: string;
      driveId: string;
      rootItemId: string;
      displayPath: '/backlogger-sync';
    };
```

Migration rules:

- Existing state containing `folderPath` migrates in memory to `local-folder` and is backed up before rewriting.
- Android creates `onedrive` state only after account, folder, manifest, and notebook identity validation.
- Portable notebook import/export never includes `SyncLocation`, account identity, device identity, tokens, pending remote metadata, or ignored-update session state.
- Disconnect retains notebook content, pending snapshots, and known history but clears the active remote location after confirmation.

## 14. Implementation milestones

| Milestone | Deliverable | Exit check |
| --- | --- | --- |
| 0 — Live-data safety | Back up the existing OneDrive folder; record its current manifest and snapshot inventory without modifying it | Backup opens and validates; no writes to live sync data |
| 1 — Android shell | Tauri Android project, mobile entry point, platform config, local storage, responsive/touch UI | Debug APK launches; local create/edit/reorder/delete survives process restart |
| 2 — Transport refactor | Filesystem I/O behind `SyncTransport`; current Windows behavior unchanged | Existing unit tests pass; isolated two-folder desktop convergence still passes |
| 3 — Microsoft sign-in | Entra registration, MSAL Kotlin bridge, single-account state, sign-out/re-auth handling | Real device signs in, silently reacquires a token, and never exposes tokens to JS/logs |
| 4 — Read-only OneDrive | Resolve `/backlogger-sync`, list all pages, download and validate manifest/snapshots | Android reads the existing history and identifies the same heads without writing |
| 5 — Android publication | Immutable upload, idempotency, ETag manifest update, retries, pending queue | Android publishes into an isolated OneDrive test folder; simulated races preserve both heads |
| 6 — Lifecycle and UX | Startup/resume checks, coalesced publication, offline/pause/re-auth UI, content-URI import/export | App kill, offline edit, resume, and expired-token tests lose no local work |
| 7 — Shared live-folder acceptance | Windows filesystem transport and Android Graph transport use the real existing folder | Both devices converge through sequential and concurrent edits; no nested folder is created |
| 8 — Release candidate | Release signing, APK/AAB, documentation, final regression and accessibility pass | Signed artifact installs and passes the acceptance checklist on a physical Android device |

Do not combine milestones 4 and 5 against the live folder. Complete read-only verification before authorizing Android writes to existing data.

## 15. Automated tests

Keep the current date, storage, reorder, protocol, ancestry, merge, conflict, and retention tests. Add transport-contract and coordinator tests covering:

- Existing `/backlogger-sync` discovery and explicit prevention of nested `backlogger-sync/backlogger-sync`.
- Folder, manifest, or snapshots directory missing.
- Child-list pagination through multiple `@odata.nextLink` pages.
- Download redirects and expired download URLs.
- `401` with one silent refresh, then interactive re-auth requirement.
- `403` consent/permission loss, `404` disappearance, `412` manifest version race, `429` with `Retry-After`, transient `5xx`, timeouts, and offline state.
- Duplicate immutable snapshot with identical content versus different content.
- Two publishers reading the same manifest and publishing different heads.
- A Windows-delivered snapshot arriving late after Android has already read the folder.
- Interrupted snapshot upload, confirmed snapshot with failed manifest update, and restart with a durable pending publication.
- Process termination immediately after local save and at every publication boundary.
- Account change while pending work exists.
- Checkpoint creation, protected branches, and interrupted remote cleanup.
- Malformed documents, future protocol versions, notebook mismatch, missing ancestry, and provider-renamed duplicate files.

Use a fake Graph server or mock native transport for deterministic failure tests. Never use the live OneDrive folder as an automated-test fixture.

## 16. Real-device acceptance checklist

Run these manually and record outcomes in the relevant milestone handoff in `mobile-implementation.md`:

1. Confirm the Android app identifies the existing `OneDrive/backlogger-sync/notebook.json` and does not create another folder.
2. Start with Windows current and Android stale; Android fetches the available Windows version before editing.
3. Edit on Windows, close to publish, wait for OneDrive delivery, resume Android, and fetch the update.
4. Edit on Android, allow publication, wait for the Windows OneDrive client to download it, open Windows, and fetch the update.
5. Make distinct offline edits on both devices and confirm an automatic safe merge.
6. Make conflicting edits to the same field and confirm both values remain recoverable until explicitly resolved.
7. Delete on one device while editing the same record on the other and confirm explicit conflict handling.
8. Kill Android immediately after an edit; restart offline and confirm the local edit and pending state survive.
9. Expire or revoke authentication; confirm local editing remains available and remote publication waits for sign-in.
10. Pause, disconnect, sign out, sign back in, and switch account; confirm no pending content is sent to an unconfirmed account.
11. Exceed 30 sequential publications in an isolated provider folder and verify safe checkpoint retention before repeating only the necessary check against live data.
12. Verify import/export, backups, Undo, theme, date rollover, keyboard behavior, touch reordering, font scaling, rotation, and accessibility on a physical phone.

## 17. Release criteria

The Android/OneDrive work is complete only when:

- A signed APK installs and runs on a physical supported Android device.
- The local app remains useful with no OneDrive account and survives restarts and forced process termination.
- Sign-in uses MSAL with no embedded client secret or token leakage.
- Android and Windows read and publish the same protocol in the existing OneDrive `/backlogger-sync` folder.
- Snapshot writes are immutable and manifest updates are concurrency-checked.
- Offline, throttled, expired-auth, corrupt-remote, and concurrent-edit scenarios preserve local and remote recoverability.
- The live folder has been backed up and passes the two-device checklist without creating a nested sync folder.
- Windows packaging and its existing local-folder sync behavior still pass regression checks.
- The README explains Android setup, Entra configuration, requested permission, build/install commands, lifecycle limitations, and recovery steps.

## 18. External setup required from the user

Implementation can be completed in this repository after setup gate A. Final OneDrive and release verification additionally requires:

- Access to create/configure the Microsoft Entra app registration.
- The Entra client/application ID and registered Android redirect details. The client ID is configuration, not a secret.
- Consent to the delegated `Files.ReadWrite` permission after reviewing its broad account-level wording.
- A physical Android device signed into the intended Microsoft account.
- A backup of the current OneDrive `backlogger-sync` folder before write testing.
- A production Android package identifier and signing key before a release build or Play Store upload.

Passwords, refresh tokens, access tokens, signing-key passwords, and private signing keys must never be committed or pasted into project documentation.

## 19. Primary references

- [Microsoft Graph: working with files and path-based drive items](https://learn.microsoft.com/en-us/graph/api/resources/onedrive?view=graph-rest-1.0)
- [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference)
- [MSAL Android overview](https://learn.microsoft.com/en-us/entra/msal/android/)
- [Microsoft identity authentication flows and PKCE](https://learn.microsoft.com/en-us/entra/identity-platform/msal-authentication-flows)
- [Microsoft Graph paging](https://learn.microsoft.com/en-us/graph/paging)
- [Tauri Android prerequisites](https://v2.tauri.app/start/prerequisites/#android)
- [Tauri Android distribution](https://v2.tauri.app/distribute/google-play/)
- [Android Studio SDK Manager and required packages](https://developer.android.com/studio/intro/update)
- [Install the Android NDK](https://developer.android.com/studio/projects/install-ndk)
- [Create and manage Android virtual devices](https://developer.android.com/studio/run/managing-avds)
- [Download Node.js](https://nodejs.org/en/download)
