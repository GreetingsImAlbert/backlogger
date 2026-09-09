# Backlogger agent notes

## Repository

- Backlogger is an offline-first Tauri 2 app with a plain TypeScript/Vite/CSS interface. Windows and Android share this repository.
- Keep the application identifier `local.backlogger.desktop` and the existing Windows app-data location unchanged.
- Current Android work is defined in `mobile-implementation.md`; setup, safety gates, and acceptance checks are in `mobile.md`. `REMOVED.md` is historical context, not an active plan.

## Commands

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

- Windows release: `npm.cmd run tauri -- build --ci`; NSIS output is under `src-tauri/target/release/bundle/nsis/`.
- Android first setup: `npm.cmd run tauri -- android init --ci --skip-targets-install`. The generated `src-tauri/gen/` tree is ignored.
- Android development: `npm.cmd run android:dev`. Emulator debug APK: `npm.cmd run android:build`; the current script targets x86_64 and is not a signed production build.
- Android builds on Windows require Android Studio/SDK/NDK, Rust Android targets, and Windows Developer Mode for symlinks.

## Supabase workflow

- The user runs all Supabase operations manually. Codex must not run migrations, resets, links, pushes, remote tests, or other destructive database commands.
- After any change to `supabase/migrations/`, tables, RLS, grants, RPCs, seed data, or generated database types, remind the user to run this local sequence from the repository root:

```powershell
npm.cmd run supabase:start
npm.cmd run supabase:reset:local
npm.cmd run supabase:test:db
npx.cmd supabase db lint --local
npm.cmd run supabase:types:local
npm.cmd run check
npm.cmd test
npm.cmd run build
```

- Create a new migration manually with `npx.cmd supabase migration new <name>`. Never edit an already-applied remote migration; add a new one.
- For the development project only, the user manually runs `npx.cmd supabase link --project-ref <DEV_PROJECT_REF>`, then `npx.cmd supabase db push --linked --dry-run`, reviews the SQL, and runs `npx.cmd supabase db push --linked`. After a remote schema change, lint and regenerate linked types with:

```powershell
npx.cmd supabase db lint --linked
cmd /c "npx.cmd supabase gen types typescript --linked > supabase/database.types.ts"
```

- `npx.cmd supabase test db --linked` is allowed only against the disposable development project, never production. Never run `npx.cmd supabase db reset --linked`.
- Do not mark a database-related milestone verified until the user reports the relevant manual commands and results. Remind the user of these commands whenever a change touches the database contract because Codex cannot apply or verify those migrations itself.

## Architecture and invariants

- `src/main.ts` owns UI orchestration; keep domain logic testable in focused modules such as `dates.ts`, `storage.ts`, `reorder.ts`, and `sync.ts`.
- Calendar values are date-only `YYYY-MM-DD` strings. Scheduled dates and deadlines are independent, and weekday notation never implies recurrence.
- Preserve stable IDs, canonical category/task ordering, serialized saves, schema validation, backups, explicit recovery, and the desktop single-instance guard.
- Task drag-and-drop stays within its category. Keep Move up/down actions as the keyboard and non-drag fallback.
- Device preferences, credentials, transport bindings, device identity, and pending publication state never belong in portable notebook exports or shared snapshots.
- Android Milestone 1 has native local persistence. Android OneDrive and document import/export remain disabled until their milestones implement and verify them.

## Sync safety

- Local app data is authoritative; the shared folder is an exchange history containing `backlogger-sync/notebook.json` and immutable `backlogger-sync/snapshots/<id>.json` files.
- Windows stores the selected parent directory and appends `backlogger-sync`. Android must bind the actual OneDrive folder item; never append the folder name twice.
- Never initialize, reset, prune, or destructively test the live OneDrive `backlogger-sync` folder. Follow the gates in `mobile.md`; use `/backlogger-sync-test` for provider write tests.
- Validate notebook identity and complete ancestry. Use ancestry—not timestamps or device revisions—to reconcile versions. Missing, partial, invalid, or unavailable remote data never means an empty notebook.
- Preserve pending work, concurrent heads, and unresolved conflicts across restarts. Never overwrite an immutable snapshot or publish to an unconfirmed account/folder.

## Working practice

- Preserve unrelated changes in the working tree and keep secrets, tokens, signing keys, and machine-specific credentials out of Git.
- The user runs Supabase migrations, resets, links, pushes, and database tests manually; prepare the files and commands, but do not run remote or destructive Supabase operations on their behalf.
- The user creates Git commits manually; do not commit or amend history unless explicitly requested.
- Run the checks relevant to every changed layer. Record each mobile milestone's concise handoff and evidence beneath that milestone in `mobile-implementation.md`.
- Do not recreate the retired `PLAN.md`, `PROGRESS.md`, `feature.md`, `feature_drop.md`, or `FEATURES.md` files.
