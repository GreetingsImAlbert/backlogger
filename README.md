# Backlogger

A compact offline-first task list for Windows and Android. The active Android/OneDrive plan is in [mobile-implementation.md](mobile-implementation.md), with setup and safety gates in [mobile.md](mobile.md). Retired desktop and sync decisions are summarized in [REMOVED.md](REMOVED.md).

Licensed under the [MIT License](LICENSE).

The current checkpoint includes the Windows release candidate and Android Milestones 1–2. It can create, edit, reorder, move, and delete categories and tasks, and it supports concrete work dates plus independent deadlines. Changes autosave locally: native builds write a versioned JSON file in app data, while the browser preview uses local storage. Windows also includes JSON import/export, recovery, single-instance enforcement, and session-based folder sync. Provider-backed two-device verification remains a release check; Android OneDrive and document import/export are planned but not yet implemented.

## Browser preview

The interface defaults to dark mode. Use the sun/moon button to switch themes; your choice is saved locally. Category and task actions live under their `…` menus, and Import/Export are in the top-right menu. Click a task title to edit it. Today's work remains underlined; overdue dates carry a small `!` marker.

With Node.js installed:

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://127.0.0.1:1420. The development server binds to the local machine only.

## Checks

```powershell
npm.cmd run build
```

This type-checks the TypeScript and builds the frontend. It does not compile the desktop host.

## Desktop development

Follow the [official Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows): Rust with the MSVC toolchain, Microsoft C++ Build Tools, and WebView2. Then start a fresh terminal and run:

```powershell
npm.cmd run tauri -- dev
```

Native compilation and NSIS installer bundling have been verified on Windows.

To build the Windows release executable and NSIS installer:

```powershell
npm.cmd run tauri -- build
```

The installer is written to `src-tauri/target/release/bundle/nsis/`.

The current installer is an unsigned local release candidate. Windows may show the normal publisher warning until an Authenticode certificate is added.

For isolated folder-sync development, set the debug profile and the **exchange folder itself** before starting Tauri. This avoids creating `backlogger-sync/backlogger-sync`; production builds ignore these variables:

```powershell
$env:VITE_BACKLOGGER_SYNC_PROFILE = 'test'
$env:VITE_BACKLOGGER_SYNC_TEST_ROOT = 'C:\path\to\backlogger-sync-test'
npm.cmd run tauri -- dev
```

Use only an isolated test folder for this profile. The normal Windows sync setting remains the parent directory, and the app appends `backlogger-sync` to it.

## Android development

Android support uses the same repository and Tauri 2 shell. Install Android Studio with an API 36 SDK, emulator, platform tools, and NDK, plus Rust Android targets. On Windows, enable **Developer Mode** so Tauri can create the native-library symlinks used by the Android build. Keep an emulator or USB device online before starting a build or dev session.

Initialize the generated Android project once, then use the repeatable scripts:

```powershell
npm.cmd run tauri -- android init --ci --skip-targets-install
npm.cmd run android:dev
npm.cmd run android:build
```

`android:dev` temporarily binds Vite to all local interfaces so the emulator or a USB device can reach the host; the normal `npm.cmd run dev` preview remains bound to `127.0.0.1`.

The debug package is written to `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` and uses package ID `local.backlogger.desktop`. Install it on the connected emulator with the Android SDK `adb` executable, for example:

```powershell
& "$env:ANDROID_HOME\platform-tools\adb.exe" install -r "src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk"
```

Milestone 1 keeps Android data in the native app-data directory. OneDrive sync and Android document import/export remain visibly unavailable until their later milestones; the desktop folder-sync behavior and Windows app-data path are unchanged.

## Project layout

- `src/`: plain TypeScript/CSS interface, domain logic, storage, sync protocol, and platform capabilities.
- `src/storage.ts`: versioned document validation, import parsing, backup handling, and browser/desktop storage routing.
- `src/sync.ts`: sync identity, immutable snapshot/manifest validation, pending publication state, ancestry, and merge logic.
- `src/sync/`: typed transport boundary, shared coordinator, and Windows local-folder adapter.
- `src-tauri/`: shared native host, platform configuration, app-data commands, and generated mobile project inputs.
