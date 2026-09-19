# Backlogger agent notes

## Repository

- Backlogger is an offline-first Tauri 2 app with a plain TypeScript/Vite/CSS interface. Windows and Android share this repository.
- Keep the application identifier `local.backlogger.desktop` and the existing Windows app-data location unchanged.
- `mobile-implementation.md` is the only active implementation plan and covers Android setup, milestones, verification, and release criteria.

## Commands

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
```

- Windows release: `npm.cmd run tauri -- build --ci`; NSIS output is under `src-tauri/target/release/bundle/nsis/`.
- Temporary Windows sync rollback build: `npm.cmd run windows:build:legacy-sync`. The normal build defaults to the v2 record protocol.
- Android first setup: `npm.cmd run tauri -- android init --ci --skip-targets-install`. The generated `src-tauri/gen/` tree is ignored.
- Android development: `npm.cmd run android:dev`. Emulator debug APK: `npm.cmd run android:build`; the current script targets x86_64 and is not a signed production build.
- Android arm64 release: set `BACKLOGGER_ANDROID_KEYSTORE`, `BACKLOGGER_ANDROID_KEY_ALIAS`, `BACKLOGGER_ANDROID_STORE_PASSWORD`, and `BACKLOGGER_ANDROID_KEY_PASSWORD` in the current PowerShell session, then run `npm.cmd run android:release`; use `npm.cmd run android:release:aab` only when an AAB is needed. Keep the keystore outside the repository and never commit generated signing properties or passwords.
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

- `src/main.ts` owns UI orchestration; keep domain logic testable in focused modules such as `dates.ts`, `storage.ts`, `reorder.ts`, `local-db/`, and `sync-v2/`.
- Calendar values are date-only `YYYY-MM-DD` strings. Scheduled dates and deadlines are independent, and weekday notation never implies recurrence.
- Preserve stable IDs, canonical category/task ordering, serialized saves, schema validation, backups, explicit recovery, and the desktop single-instance guard.
- Task drag-and-drop stays within its category. Keep Move up/down actions as the keyboard and non-drag fallback.
- Device preferences, credentials, transport bindings, device identity, acknowledged bases, cursors, and outbox state never belong in portable notebook exports or shared cloud records.
- Android has native local persistence, foreground Supabase v2 sync, and system document-provider import/export through content streams. These remain subject to the acceptance gates in `mobile-implementation.md`; never treat a `content://` URI as a desktop filesystem path.

## Sync safety

- The UI reads and writes only through the local SQLite repository. Optional Windows and Android sync reconcile those records with the signed-in user's canonical Supabase v2 notebook in the background.
- Preserve stable record IDs, per-field clocks, acknowledged bases, soft-delete tombstones, the durable outbox, and the server `change_seq` cursor across restarts.
- Pull ordered ledger changes by cursor and apply records plus cursor atomically. Push through optimistic version checks; stale writes use the tested three-way merge and bounded retry rules.
- Realtime events are wake-ups only. Validate and fetch ledger changes before touching local state, keep periodic polling as the recovery path, and keep Android Realtime foreground-only.
- Login is read-only. Creating the first v2 notebook requires explicit **Start sync** confirmation. Never publish to an unconfirmed account/project/notebook binding.
- Missing, partial, invalid, unauthorized, or unavailable cloud data never means an empty notebook and never authorizes local replacement or deletion.
- Legacy snapshots/manifests and schema-1/2 folder state are read-only migration or rollback inputs. Do not dual-write or remove them during the staged rollout; cleanup requires a stable release and explicit user approval.

## Working practice

- Preserve unrelated changes in the working tree and keep secrets, tokens, signing keys, and machine-specific credentials out of Git.
- If Computer Use through `cua_repl` reports `Trusted RPC service is not configured: sky`, use the `computer-use` skill for native Windows automation through trusted `node_repl` and `@oai/sky`, not `cua_repl`. If `node_repl` is not directly visible, inspect the callable tool inventory for `mcp__node_repl__js` and invoke it. Follow the skill's initialization, observation, input, and approval rules.
- The user runs Supabase migrations, resets, links, pushes, and database tests manually; prepare the files and commands, but do not run remote or destructive Supabase operations on their behalf.
- The user creates Git commits manually; do not commit or amend history unless explicitly requested.
- A sole user prompt of `cm` means: provide a concise commit message covering every uncommitted change since the last commit, following the repository's existing title, blank line, and bullet format. Summarize major changes rather than listing implementation details. Always place the entire commit message inside a fenced `text` code block.
- Windows release messages use the established Markdown format: version heading, short summary, Highlights, optional advisory blockquote, Installation with the versioned NSIS filename and unsigned warning, then SHA-256. Place the complete message in a fenced `text` block.
- Run the checks relevant to every changed layer. Record each mobile milestone's concise handoff and evidence beneath that milestone in `mobile-implementation.md`.
- Do not recreate the retired `PLAN.md`, `PROGRESS.md`, `feature.md`, `feature_drop.md`, `FEATURES.md`, `REMOVED.md`, `supabase-migration.md`, or `realtime.md` files.
