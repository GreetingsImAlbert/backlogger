# Backlogger

Backlogger is a compact, offline-first task list for Windows and Android. Local mode needs no account or hosted service: install the app and use it. Windows additionally offers optional cloud sync through Supabase with Google login.

Backlogger supports categories, ordered tasks, scheduled work dates, independent deadlines, themes, autosave, recovery, and JSON import/export. Windows and Android share this repository but have independent release versions.

Licensed under the [MIT License](LICENSE).

## Run locally

Install Node.js, then run:

```powershell
npm.cmd install
npm.cmd run dev
```

Open <http://127.0.0.1:1420>. The browser preview uses local storage and does not enable native cloud sync.

For the Windows app, install the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows)—Rust with the MSVC toolchain, Microsoft C++ Build Tools, and WebView2—then run:

```powershell
npm.cmd run tauri -- dev
```

## Optional Supabase sync

Windows users may choose **Log in to Sync**, authenticate with Google, and explicitly start syncing. Logging out disconnects the account but keeps the local notebook. If cloud and local histories differ, the app offers **Fetch** to replace the local notebook or **Merge** to union their categories and tasks. Pending work and the authenticated session survive restarts; local mode remains available when Supabase is unavailable or not configured.

For development:

1. Create `.env.local` from `.env.example`.
2. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` for the development project.
3. Apply the migrations in `supabase/migrations/` and configure Google authentication plus the documented redirect URL in Supabase.

Vite embeds its environment values into the client bundle. Only the public Supabase project URL and publishable key belong in these files. Never put a Supabase service-role key, Google client secret, access token, signing key, or other private credential in the app or Git.

Local database workflow:

```powershell
npm.cmd run supabase:start
npm.cmd run supabase:reset:local
npm.cmd run supabase:test:db
npx.cmd supabase db lint --local
npm.cmd run supabase:types:local
```

To deploy a new migration to the development project, manually link it, preview the change, and then push it:

```powershell
npx.cmd supabase link --project-ref <DEV_PROJECT_REF>
npx.cmd supabase db push --linked --dry-run
npx.cmd supabase db push --linked
npx.cmd supabase db lint --linked
cmd /c "npx.cmd supabase gen types typescript --linked > supabase/database.types.ts"
```

Never reset a linked remote database. Create a new migration instead of editing one that has already been applied remotely.

## Verify and build Windows

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
npm.cmd run security:secrets
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri -- build --ci
```

The unsigned NSIS installer is written under `src-tauri/target/release/bundle/nsis/`. Windows may show an unknown-publisher warning until releases are code-signed.

## Android development

Android uses the same Tauri 2 codebase and application identifier, `local.backlogger.desktop`, while retaining its own release version. Install Android Studio with the SDK, platform tools, emulator, and NDK; add the Rust Android targets; and enable Windows Developer Mode for build symlinks.

```powershell
npm.cmd run tauri -- android init --ci --skip-targets-install
npm.cmd run android:dev
npm.cmd run android:build
```

Android currently has native local persistence; cloud sync and document import/export remain disabled pending the revised mobile plan. The current debug build targets x86_64 and is not a signed production release.

## Project layout

- `src/`: TypeScript/CSS interface, domain logic, local storage, and sync orchestration.
- `src/sync.ts`: sync state, snapshots, manifests, ancestry, and merge behavior.
- `src/sync/`: the Supabase transport and provider-neutral coordinator.
- `src-tauri/`: shared native host, platform configuration, and app-data/document commands.
- `supabase/`: database migrations, pgTAP tests, generated types, and local configuration.
