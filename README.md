# Backlogger

Backlogger is a small, no-fuss task notebook for Windows and Android. Organize tasks into categories, choose the days you want to work on them, and keep deadlines visible without turning everything into a complicated project-management system.

Your tasks are saved directly on your device. There is no required account, subscription, or internet connection—just install it and start writing. Windows also has optional Google login for syncing through Supabase.

## Highlights

- Categories and freely ordered tasks
- Multiple scheduled work dates and independent deadlines
- Today and Tomorrow views
- Drag-and-drop prioritization with keyboard-friendly alternatives
- Light/dark mode and multiple color themes
- Automatic local saving and recovery, with JSON import/export on Windows and Android
- Optional live Windows/Android sync while keeping offline editing available

## Download

Download the latest build from [GitHub Releases](../../releases).

- **Windows:** run the `.exe` installer. Releases are currently unsigned, so Windows may show an Unknown publisher or SmartScreen warning.
- **Android:** install the arm64 release APK on a physical Android phone. Android builds are released independently from Windows.

Windows and Android versions are released independently even though they share this repository.

Licensed under the [MIT License](LICENSE).

## Development setup

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

## Optional Windows sync

Windows users can choose **Log in to Sync** and authenticate with Google. Login only checks for an existing notebook; creating the first cloud notebook still requires **Start sync** confirmation. After connection, edits save locally first and sync automatically in the background. Record-level conflict handling, soft deletes, Realtime updates, and periodic catch-up run without manual Fetch/Merge steps. Logging out keeps the local notebook, and offline edits remain queued for later.

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

`android:build` creates an unsigned x86_64 debug APK for an emulator. For a physical arm64 release APK, create the external production keystore and set the four `BACKLOGGER_ANDROID_*` signing variables described in [mobile-implementation.md](mobile-implementation.md), then run:

```powershell
npm.cmd run android:release
```

The optional Play Store bundle command is `npm.cmd run android:release:aab`. The release script writes only ignored generated signing properties, keeps the keystore outside the repository, verifies the APK signature, and prints the artifact hash. Android local persistence, document import/export, and optional foreground Supabase sync are enabled; sync still requires login and remains unnecessary for local use.

## Project layout

- `src/`: TypeScript/CSS interface, domain logic, local storage, and sync orchestration.
- `src/local-db/`: SQLite-backed local records, preferences, recovery, sync bases, outbox, and cursor.
- `src/sync-v2/`: record contracts, validation, merge/order rules, Supabase transport, worker, Realtime lifecycle, and rollout controls.
- `src/sync.ts` and `src/sync/`: read-only legacy migration and temporary rollback support.
- `src-tauri/`: shared native host, platform configuration, and app-data/document commands.
- `supabase/`: database migrations, pgTAP tests, generated types, and local configuration.
