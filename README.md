# Backlogger

A compact local desktop task list, built in milestones. See [PLAN.md](PLAN.md) for the intended behavior and [PROGRESS.md](PROGRESS.md) for implementation status.

Licensed under the [MIT License](LICENSE).

The current checkpoint is a **local editing preview plus a Windows release build**. It can create, edit, reorder, move, and delete categories and tasks, and it supports concrete work dates plus independent deadlines. Changes autosave locally: the desktop build writes a versioned JSON file in its Tauri app-data directory, while the browser preview uses local storage. JSON export/import, sync-snapshot recovery import, explicit backup recovery, save retry, native single-instance enforcement, session-based folder sync, startup fetch locking, delayed-update notices, close-time publication, stale-descendant protection, three-way merging, durable conflict choices, versioned checkpoint retention, and local folder-health reporting are implemented. Provider-specific two-device verification remains a separate release check.

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

## Project layout

- `src/`: plain TypeScript/CSS interface and isolated sample fixtures.
- `src-tauri/`: native window host and configuration.
- `src/storage.ts`: versioned document validation, import parsing, backup handling, and browser/desktop storage routing.
- `src/sync.ts`: local sync identity, immutable snapshot/manifest validation, pending publication state, and provider-folder paths.
- `src-tauri/`: native window host plus atomic-ish app-data writes with a last-known-good backup.
