# Supabase sync migration milestones

This is the implementation contract for replacing Backlogger's folder-based sync transport with Supabase. It is intentionally explicit so each milestone can be assigned independently to a less-capable implementation agent.

The local app remains fully usable without an account or network connection. Google login is required only when the user chooses to enable cloud sync.

## Instructions for every assigned agent

1. Implement only the assigned milestone. Read this entire document, `AGENTS.md`, the current code, and all earlier milestone handoffs before editing.
2. Do not reset the worktree, rewrite unrelated code, change `local.backlogger.desktop`, change Windows app-data paths, or couple Windows and Android release versions.
3. Preserve local-first behavior. A failed login, unavailable network, invalid remote record, or Supabase error must never erase or replace the local notebook.
4. Do not simplify the existing sync protocol. Preserve snapshot IDs, notebook IDs, ancestry, three-way merge behavior, explicit conflict resolution, pending publication recovery, checkpoints, and the 30-snapshot retention limit.
5. Keep `SYNC_PROTOCOL_VERSION` at `1` unless a reviewed protocol incompatibility truly requires a new version. Moving JSON from files to Postgres is not a protocol change.
6. Never commit or log Google client secrets, Supabase service-role/secret keys, database passwords, OAuth codes, access tokens, refresh tokens, or complete notebook payloads.
7. Complete every test that does not require user interaction. If Google login, a remote project, or another external prerequisite is unavailable, report the exact missing gate instead of claiming the milestone passed.
8. After completing a milestone, append a `### Milestone N handoff` subsection directly beneath it. Record changed files, migrations, commands/results, manual evidence, unresolved issues, and the exact interface the next milestone should use.

## Scope and invariants

### In scope

- Replace the Windows `Choose folder` flow with `Log in to Sync` and one visible provider: `Continue with Google`.
- Store the existing manifest and immutable snapshot JSON in Supabase Postgres `jsonb` columns.
- Use Supabase Auth for Google identity and Supabase Row Level Security for per-user isolation.
- Keep the current local notebook, local backup, device ID, pending queue, sync status, conflict choices, and recovery state on each device.
- Make the Supabase transport reusable by the Android app, but enable and release it on Windows first. Android auth callbacks, lifecycle acceptance, and release work remain for the revised mobile plan.
- Retire the active local-folder/OneDrive transport only after Supabase passes the cutover tests.

### Out of scope

- Google Drive access. Google is the login provider only; request no Drive scopes.
- Supabase Storage buckets, Realtime, Edge Functions, background services, collaboration between different users, shared/team notebooks, password login, magic links, and account-management screens.
- Automatic upload of the old OneDrive directory or deletion/modification of anything in it.
- Multiple notebooks per account. The first schema supports exactly one Backlogger notebook per Supabase user.
- Android production enablement. Do not silently turn on incomplete Android sync during this migration.

### Behavior that must remain unchanged

- Local edits save immediately and remain usable offline.
- Sync publishes complete immutable snapshots rather than field-level mutations.
- Ancestry, not timestamps or per-device revision numbers, determines fast-forward, divergence, and merge behavior.
- Independent changes merge; same-field and delete/edit conflicts remain explicit and recoverable.
- Fetching a remote version that would discard visible local work requires confirmation and a local backup first.
- A snapshot is durable locally before its upload begins. Failed or uncertain publication remains pending across restart.
- Snapshot IDs are immutable. The same ID plus semantically identical JSON is idempotent; the same ID plus different JSON is a hard error.
- Manifest updates use an expected version and never fall back to an unconditional overwrite.
- Startup and foreground checks, manual `Check for updates`, the current 15-second foreground retry, pause/resume, and Windows close-time publication remain.
- Retention compacts only a single complete resolved lineage. Pending work, concurrent heads, missing ancestry, or conflicts stop cleanup.
- Portable notebook exports contain no account, auth, device, transport, pending-publication, or sync-state data.

## Target architecture

```text
Windows Backlogger now                Supabase migration target

local notebook                        local notebook (unchanged)
backlogger.sync.json                  device sync state (versioned locally)
        |                                      |
LocalFolderSyncTransport              SupabaseSyncTransport
        |                                      |
backlogger-sync/notebook.json         sync_notebooks.manifest (jsonb)
backlogger-sync/snapshots/*.json      sync_snapshots.payload (jsonb)
                                               |
                                      Supabase Auth + RLS
                                               |
                                      Google identity
```

Keep `src/sync.ts` responsible for validation, ancestry, checkpointing, merging, and conflicts. Keep `src/sync/coordinator.ts` responsible for protocol orchestration. Provider queries belong in `src/sync/supabase-transport.ts`; authentication belongs under `src/supabase/`.

## Required database shape

Create reproducible SQL migrations under `supabase/migrations/`. Do not make the Dashboard the only copy of the schema.

### `public.sync_notebooks`

| Column | Type | Rules |
| --- | --- | --- |
| `notebook_id` | `text` | Primary key; equal to the existing protocol notebook ID |
| `owner_id` | `uuid` | Required; references `auth.users(id)` with cascade delete |
| `manifest` | `jsonb` | Required; stores the existing `SyncManifest` object |
| `manifest_version` | `bigint` | Required, starts at 1, increases once per successful manifest CAS |
| `created_at` | `timestamptz` | Required, defaults to `now()` |
| `updated_at` | `timestamptz` | Required, updated only with a successful manifest CAS |

Add a unique constraint on `owner_id` so one Supabase user cannot accidentally initialize multiple active notebooks. Add checks for a nonblank ID, positive manifest version, `manifest.type = 'manifest'`, protocol version `1`, and `manifest.notebookId = notebook_id`.

### `public.sync_snapshots`

| Column | Type | Rules |
| --- | --- | --- |
| `notebook_id` | `text` | Foreign key to `sync_notebooks(notebook_id)` with cascade delete |
| `snapshot_id` | `text` | Existing protocol snapshot ID |
| `payload` | `jsonb` | Required; stores the complete existing `SyncSnapshot` object |
| `created_at` | `timestamptz` | Required, defaults to `now()`; not used to decide winners |

Use `(notebook_id, snapshot_id)` as the primary key. Add checks for nonblank IDs, protocol version `1`, type `snapshot` or `checkpoint`, and matching payload notebook/snapshot IDs. Add an index on `notebook_id`. Grant no direct `UPDATE` path for snapshots.

### Required database functions

Implement these as transaction-safe Postgres functions. Use explicit schemas. Prefer `security invoker`; if a function needs `security definer`, set `search_path = ''`, fully qualify every relation/function, verify `auth.uid()` inside the function, revoke execution from `public` and `anon`, and grant it only to `authenticated`.

1. `initialize_sync_notebook(...)`
   - Accept notebook ID, initial checkpoint ID, validated checkpoint JSON, and manifest JSON whose only head is that checkpoint.
   - Require an authenticated user and matching IDs/protocol fields.
   - Insert the notebook and checkpoint in one transaction.
   - Enforce one notebook per owner. Never replace an existing notebook.
   - Return the stored manifest and version.
2. `create_sync_snapshot(...)`
   - Verify the caller owns the notebook.
   - Insert without overwriting.
   - If the composite ID already exists, compare `jsonb` values. Return `already-identical` only for equality; raise a distinct immutable-content conflict otherwise.
3. `compare_and_swap_sync_manifest(...)`
   - Accept notebook ID, expected manifest version, and next manifest JSON.
   - Verify owner and manifest identity/protocol.
   - Atomically update only when the stored version equals the expected version.
   - Increment the version and return `{ applied, manifest, manifest_version }`.
   - A version mismatch returns `applied = false`; it must not overwrite or merge server-side. The TypeScript coordinator re-reads and reconciles.
4. `delete_pruned_sync_snapshot(...)`
   - Verify owner.
   - Delete only when the snapshot ID is present in the current manifest's `prunedSnapshotIds` and absent from `headSnapshotIds`.
   - Missing rows are idempotent success. This operation is for verified retention cleanup only.

Enable RLS on both tables. Authenticated users may select only rows belonging to their own `auth.uid()`. Anonymous access must return no rows. Do not expose direct authenticated insert/update/delete grants that bypass the functions above. The service-role key must never be used by the application.

## Device-local sync state after migration

Bump `SYNC_SCHEMA_VERSION` from `2` to `3`. Add:

```ts
interface SupabaseLocation {
  kind: 'supabase';
  accountId: string; // Supabase auth user id, not email
  projectRef: string; // non-secret environment guard
}
```

`SyncLocation` becomes Supabase-only after final cleanup. During migration, the parser must still accept schema versions 1 and 2 long enough to back them up and convert them safely.

Migration rules:

1. Back up the complete old `backlogger.sync.json` before its first schema-3 write.
2. Preserve `deviceId`, `notebookId`, pending snapshots, known heads, last-published fields, processed IDs, merge parents, conflicts, and errors in the backup.
3. Do not treat a saved local-folder or OneDrive location as a Supabase connection. The migrated live state starts disconnected with `location: null`.
4. Do not publish old pending snapshots automatically after login because their parents may exist only in the retired folder history.
5. When the user explicitly initializes an empty Supabase account, make a new parentless checkpoint from the current validated local notebook. Use the existing notebook ID when safe; otherwise create a new one. Only after atomic remote initialization succeeds may the live state replace old pending/history pointers with the new checkpoint lineage.
6. Preserve the schema-2 backup until the Supabase acceptance milestone passes. The old OneDrive folder remains untouched as an independent rollback source.
7. Logging into an account that already owns a remote notebook always reads and validates it before any upload. A notebook/account mismatch requires an explicit choice; it never means “remote is empty.”

## User setup gate A — development backend and Google login

Real authentication and provider integration tests require the user to complete these steps. Code and mock tests may proceed with placeholders before this gate.

1. Create a Supabase organization/project owned by the Backlogger developer. This single project serves all Backlogger users; end users do not create Supabase projects.
2. Use a non-production development project first. Record its project ref, Project URL, and publishable key. Do not provide or commit the database password or service-role/secret key.
3. Create/configure a Google Cloud project and OAuth consent screen. Use external audience if users outside the developer's Google account will sign in. While the consent screen is in testing, add the intended test Google accounts.
4. Request only `openid`, email, and profile scopes. Do not enable or request Google Drive scopes.
5. Create a Google OAuth client of type **Web application**. Add Supabase's exact callback URL shown on the Supabase Google provider page, normally `https://<project-ref>.supabase.co/auth/v1/callback`, as an authorized redirect URI.
6. Enable Google under Supabase Authentication providers and enter the Google client ID and client secret there. The Google client secret stays in Google/Supabase configuration and never enters this repository or app bundle.
7. Under Supabase Auth redirect URLs, allow the exact Backlogger callback `backlogger://auth/callback`. Use a separate callback/environment for development if testing and production ever use different Supabase projects.
8. Put only these client-safe values in an ignored `.env.local`:

   ```dotenv
   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_<value>
   ```

9. The user performs the first Google login, consent, MFA, and account selection personally. No password, OAuth code, or token is pasted into Codex or committed.

For reproducible database tests, install the Supabase CLI and run its local stack through Docker Desktop. Local Supabase is development-only. Never expose it publicly or run destructive reset commands against a linked production project.

## Milestone 0 — Freeze behavior and preserve rollback data

**Prerequisites:** None. Do not access or mutate the old OneDrive folder unless the user explicitly authorizes a read/backup operation.

**Files:** Tests and documentation only if gaps are found; no provider implementation.

### Steps

1. Confirm the worktree state and record the current commit.
2. Run the existing TypeScript, unit, Vite, Rust, and Windows release checks from `AGENTS.md`.
3. Add characterization tests for any current behavior not already locked down: pending publication persistence, manifest-head reconciliation, semantic duplicate snapshots, concurrent branches, conflict recovery, pause/resume, and 30-snapshot retention guards.
4. Export a normal portable notebook backup through Backlogger.
5. Back up the local `backlogger.sync.json` and its `.bak` outside the active app-data path. Record paths and SHA-256 hashes without recording notebook contents.
6. Keep the current OneDrive `backlogger-sync` directory unchanged as rollback history. If the user authorizes it, verify an existing independent backup; otherwise record that this external backup remains a user gate.

### Verify

- Baseline commands pass.
- The working local notebook still opens.
- Backup hashes and locations are recorded privately in the handoff, not committed if machine-specific.
- No OneDrive or Supabase data was written.

### Milestone 0 handoff

- **Status:** Complete for the local rollback/safety gate.
- **Baseline commit:** `216f6f1` (`docs: change Windows build version number`). The only uncommitted repository file is this plan document.
- **App state:** Backlogger was closed before copying. The authoritative Windows app-data directory is `%APPDATA%\local.backlogger.desktop`; it contained valid `backlogger.json`, `backlogger.json.bak`, and `backlogger.sync.json`.
- **Validated local state:** `backlogger.json` is schema 1, revision 272, with 10 categories; its backup is schema 1, revision 271, with 10 categories. `backlogger.sync.json` is valid schema 2, bound to a `local-folder` location, with zero pending snapshots. No files were rewritten.
- **External archive:** `C:\Users\Albert\Documents\BackloggerBackups\milestone0-20260910-014851\` contains copies of all three files, outside the app-data directory and outside OneDrive.
- **Archive SHA-256:** `backlogger.json` = `A4903D3B8801913099B81ADE102480D7712479E1CCB92222DFB3566DB089F852`; `backlogger.json.bak` = `C9FE8CD3ADA2C16AC8132508D28384BCE4E0385451F8CDA54F3B7331020C9513`; `backlogger.sync.json` = `F05A4C13539D7EF2AAF97B0039F90563E869CEE5CECB43DD951961589108EDA3`.
- **Checks:** `npm.cmd run check`, `npm.cmd test` (29 passing), `npm.cmd run build`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, and `cargo check --manifest-path src-tauri/Cargo.toml` all passed.
- **Portable export note:** The native primary document is the same validated `StoredDocument` JSON produced by `exportCurrentDocument` (`makeStoredDocument` plus JSON serialization). The Windows app-control connector exposed no native app window, so the GUI Save dialog itself was not automated; the archived primary is the export-equivalent portable backup and was validated without exposing task contents.
- **Provider safety:** No OneDrive path was opened or changed, and no Supabase project was accessed. The existing OneDrive folder remains untouched for rollback.
- **Next milestone interface:** Begin Milestone 1 with the repository baseline intact. Do not migrate or delete the archived local/OneDrive state; use the external archive as the rollback source if schema work fails.

## Milestone 1 — Add reproducible Supabase schema and security tests

**Prerequisite:** Milestone 0. User Gate A is optional for local schema work and required before pushing to a remote development project.

**Files:** New `supabase/config.toml`, `supabase/migrations/<timestamp>_sync_schema.sql`, `supabase/tests/database/sync_security.test.sql`, optional non-sensitive `supabase/seed.sql`, package scripts, `.gitignore`.

### Steps

1. Initialize the checked-in `supabase/` directory. Ignore `.temp`, local runtime data, environment files, and generated secrets.
2. Implement the two tables, constraints, indexes, grants, RLS policies, and four functions exactly as specified above.
3. Ensure direct table mutation cannot bypass immutable snapshot creation or manifest CAS.
4. Add pgTAP tests for:
   - anonymous users cannot read or mutate either table;
   - user A cannot read, initialize, publish, CAS, or delete user B's data;
   - one user can initialize exactly one notebook;
   - initialization is atomic if either JSON object is invalid;
   - identical duplicate snapshot creation is idempotent;
   - different JSON under an existing snapshot ID fails;
   - a matching manifest version updates and increments once;
   - a stale expected version changes nothing;
   - direct snapshot update and direct manifest update are denied;
   - deletion fails for active/unpruned snapshots and succeeds idempotently for pruned snapshots.
5. Add scripts with unambiguous local targets, such as `supabase:start`, `supabase:reset:local`, `supabase:test:db`, and `supabase:types:local`. Never create a script whose name hides a linked/remote destructive action.
6. Generate and commit database TypeScript types after the migration passes locally.
7. If Gate A is complete, link only the development project, preview migration changes, push them, regenerate linked types, and run a smoke query. Never reset a production project.

### Verify

```powershell
npx.cmd supabase start
npx.cmd supabase db reset --local
npx.cmd supabase test db
npm.cmd run check
```

Record the Supabase CLI version, local test count, migration filename, and whether remote development deployment was actually verified.

### Milestone 1 handoff

- **Status:** Implementation complete; local database execution and any remote deployment remain a user-run gate.
- **Changed files:** `supabase/config.toml`, `supabase/.gitignore`, `supabase/seed.sql`, `supabase/migrations/20260910033000_create_sync_schema.sql`, `supabase/tests/database/sync_security.test.sql`, `package.json`, and `AGENTS.md`.
- **Schema:** The migration adds the owner-scoped notebook/immutable snapshot tables, RLS, grants, and the four transaction-safe RPCs described above. The pgTAP file contains 37 assertions covering initialization, ownership isolation, immutable duplicates, CAS, and guarded cleanup.
- **Checks run:** Supabase CLI `2.117.0`; `npm.cmd run check` passed; `npm.cmd test` passed with 29 tests; `npm.cmd run build` passed; `git diff --check` passed.
- **Not run by Codex:** `supabase start`, local reset/test/lint, type generation, linking, preview, and remote push. Docker Desktop's daemon was unavailable, and the user runs all Supabase migrations, database tests, remote operations, and Git commits manually.
- **Generated types:** Not committed yet. Run `npm.cmd run supabase:types:local` only after the local migration and pgTAP suite pass; review the generated file before committing it.
- **Next milestone interface:** After the manual checklist passes, Milestone 2 may add the Supabase client/auth layer against these exact RPC names and generated types. Do not change the app runtime or remote database from this handoff.

## Milestone 2 — Add Supabase client and Google OAuth plumbing

**Prerequisites:** Milestone 1. Gate A is required only for real login verification.

**Files:** `package.json`, `package-lock.json`, new `src/supabase/client.ts`, `auth.ts`, `config.ts`, generated database types, `src/vite-env.d.ts`, Tauri Cargo/config/capabilities, focused auth tests.

### Steps

1. Add the current compatible `@supabase/supabase-js` v2 dependency and lock it. Do not add a second framework.
2. Add configuration parsing that requires a valid HTTPS Supabase URL and publishable key for sync-enabled builds. Missing configuration keeps local mode working and shows `Sync is not configured`; it must not crash startup.
3. Create exactly one Supabase client. Enable normal session persistence and token refresh; set `detectSessionInUrl: false` because Tauri handles the callback. Keep the session in the auth module's storage only, never in `SyncState` or notebook exports.
4. Expose only sanitized auth state to UI code: loading, signed out, signing in, signed in, user ID, and display email. Never expose or log tokens, OAuth codes, provider tokens, or the raw session.
5. Add Tauri's official opener and deep-link plugins. Configure only the custom scheme `backlogger`, and accept only the exact callback shape `backlogger://auth/callback`.
6. Preserve the existing desktop single-instance behavior. Register the single-instance plugin first with its deep-link integration, then the deep-link plugin. In Windows debug builds, register configured links at runtime so callbacks can be tested without an installed release.
7. Grant only the Tauri permissions needed to open the Supabase authorization URL and receive configured deep links. Do not add arbitrary shell execution or unrestricted URL opening.
8. Implement `Continue with Google` using Supabase OAuth with PKCE. Obtain the authorization URL without navigating the app WebView, then open it in the system browser.
9. Handle both cold-start and already-running callbacks. Reject wrong schemes/hosts/paths, duplicate or missing codes, and unsolicited callbacks. Exchange the code once, clear transient state, and never print the URL because it contains sensitive parameters.
10. Add the first-login flow as an explicit manual acceptance case. Starting from a signed-out app with no existing Supabase session, you must personally choose `Continue with Google`, select the intended test account, complete Google consent/MFA if prompted, and return to Backlogger. The app must exchange the callback code, show the sanitized signed-in account, and create exactly one corresponding Supabase Auth user. Do not automate or paste the Google password, MFA code, OAuth code, or tokens into Codex, the repository, or logs.
11. Implement sign-out and auth-expiry events. Signing out stops remote actions but does not delete the local notebook, backup, device ID, conflicts, or recoverable pending state.
12. Add unit tests around configuration failure, callback validation, cancelled login, duplicate callback, auth state changes, and sanitized error mapping. Keep the first-login browser interaction manual; test the callback/session exchange with deterministic mock codes in automation.

### Verify

- Local mode starts with no `.env.local`.
- **First-login test:** Starting signed out, `Continue with Google` opens the external browser; after the user completes Google authentication and consent, the callback returns to the same Backlogger process, the session is exchanged successfully, and one Supabase Auth user is visible for the selected account.
- A second login with the same Google account restores the same Supabase user rather than creating a duplicate.
- Restart restores the Supabase session without another login while valid.
- Sign-out clears the auth session and remote activity but preserves local data.
- App logs, `backlogger.sync.json`, exports, and Git contain no credentials or OAuth parameters.
- Windows release packaging still produces version `0.1.2` unless the user separately changes the Windows version.

## Milestone 3 — Implement `SupabaseSyncTransport`

**Prerequisites:** Milestones 1–2. Real database verification requires Gate A; deterministic tests must not require Google.

**Files:** `src/sync/transport.ts`, new `src/sync/supabase-transport.ts`, `src/sync/coordinator.ts`, `src/sync.ts`, generated database types, new transport tests.

### Steps

1. Add `supabase` to `SyncTransportKind` and implement `SupabaseLocation` with auth user ID and project ref. Do not use email as identity.
2. Rename comments/types that incorrectly require filesystem terminology, but avoid broad churn. Protocol code must receive provider-neutral entries and JSON strings/objects.
3. Give the Supabase transport strong capabilities for conditional manifest writes, immutable snapshot creation, and checked deletion.
4. `resolveLocation` validates the active session, project ref, and account binding. An account change is an explicit mismatch, not a reconnect.
5. `readManifest` selects the caller's one notebook row and returns manifest JSON plus `manifest_version` as the transport version. Zero rows means no initialized cloud notebook; multiple rows is a hard invariant error.
6. `initializeNotebook` calls the atomic initialization function with a parentless checkpoint and matching manifest. It never overwrites an existing row.
7. `writeManifest` requires an expected version and calls the CAS function. Map `applied = false` to a retriable `SyncTransportError('conflict', ...)`. Never retry by issuing an unconditional table update.
8. `listSnapshots` selects IDs for the active notebook in fixed-size pages until a short page is returned. Do not assume Supabase's row limit contains the full history.
9. `readSnapshot` selects by notebook ID plus snapshot ID and returns validated JSON. A disappearing row maps to retriable `not-found`.
10. `createSnapshot` calls the idempotent function. Accept only `created` or `already-identical`; map a different-payload collision to a non-retriable immutable conflict.
11. `deleteSnapshot` calls the guarded pruned-snapshot function. Treat an already missing row as success.
12. Add transport error codes/mapping for authentication required, permission denied, rate limited, offline/network, conflict, not found, invalid response, and transient server failure. Preserve the original error only for internal diagnostics; show sanitized user messages.
13. Never use timestamps to synthesize a transport version. The database's monotonic `manifest_version` is the only manifest CAS token.
14. Write deterministic transport tests with a fake Supabase client for pagination, auth loss, RLS-style denial, network errors, stale CAS, duplicate snapshots, invalid payloads, deletion guards, and account/project mismatch.

### Verify

- The transport contract and existing coordinator tests pass.
- Two fake publishers starting from the same manifest can create different snapshots; one CAS loses, re-reads, and later preserves both heads.
- No provider code appears in ancestry/merge functions.
- No live user data is required for the automated suite.

## Milestone 4 — Migrate local sync state and replace the connection UI

**Prerequisites:** Milestones 1–3 and the schema-3 migration rules above. Gate A is required for end-to-end login.

**Files:** `src/sync.ts`, `src/main.ts`, `src/platform/capabilities.ts`, `src/style.css`, storage/native backup commands if needed, sync-state and UI tests.

### Steps

1. Implement schema-1/2 to schema-3 parsing and backup. Never reinterpret `local-folder` or `onedrive` as `supabase`.
2. Add a provider-neutral `cloudSync`/`supabaseSync` capability. Set it true for Windows and false for Android until the mobile plan explicitly enables and verifies Android callbacks/lifecycle. Remove misleading `oneDriveSync` UI promises.
3. Replace `Choose folder` with a `Log in to Sync` entry point. The signed-out dialog contains a single provider action labeled `Continue with Google`. Do not show email/password or Google Drive language.
4. Signed-in UI shows the sanitized Google email, sync status, `Check for updates`, Pause/Resume, conflict resolution, and `Log out`. Remove folder paths and `provider desktop app` wording.
5. Use provider-neutral status text: `Not logged in`, `Signing in`, `Checking cloud sync`, `Connected`, `Saved locally`, `Offline`, `Paused`, `Conflicts`, and `Login required`.
6. Separate authentication from notebook initialization:
   - Login authenticates only; it does not upload.
   - Read the account's remote notebook immediately after login.
   - If none exists, ask the user to confirm `Start sync with this device`.
   - Create a parentless checkpoint from the current validated local notebook and atomically initialize the remote notebook.
   - Only after success bind `SupabaseLocation` and reset history pointers to the new checkpoint.
7. If the account already has a notebook, validate its manifest and complete ancestry before binding. A blank local notebook may fetch only after a clear confirmation. A nonblank/mismatched local notebook must not upload or be replaced automatically; present the existing safe fetch/merge decision and create a local backup before replacement.
8. On logout/account change, cancel or finish queued reads safely, clear the active cloud binding, and retain the local notebook and recoverable state. Never send pending data to a newly selected account without validation and confirmation.
9. Keep the old OneDrive directory and its path out of the new UI. Do not delete it from disk.
10. Ensure browser preview remains usable locally but does not claim production cloud sync unless explicitly configured for development.

### Verify

- Opening the upgraded Windows app backs up old sync state and starts local mode disconnected.
- No network request occurs until login/sync action.
- First login does not upload until `Start sync with this device` is confirmed.
- Initialization creates exactly one notebook and one checkpoint whose manifest points to it.
- Logout, cancelled login, wrong account, and restart preserve local tasks.
- UI contains no `Choose folder`, OneDrive, Google Drive, or local-folder status language.

## Milestone 5 — Restore all sync orchestration over Supabase

**Prerequisites:** Milestones 1–4. Work against local Supabase or a disposable development project only.

**Files:** `src/main.ts`, `src/sync/coordinator.ts`, sync modules and tests.

### Steps

1. Replace guards based on `storageKind() === 'desktop'` and `localSyncParentPath()` with provider-neutral checks for local-storage readiness, authenticated/bound transport, status, notebook ID, and unresolved conflicts.
2. Preserve the serialized sync mutation queue. Auth state changes and callbacks must not race publication or fetch operations.
3. Keep local persistence before remote publication. Queue a complete snapshot exactly as today; never mutate a snapshot after upload may have started.
4. Publish snapshots in the same order. After an immutable snapshot insert, re-read the latest manifest and compute heads using the existing ancestry functions.
5. On a stale manifest CAS, leave the snapshot pending, re-read manifest/snapshots, reconcile, and retry a bounded maximum of three times with small jitter. If safety is still uncertain, stop and show a retryable conflict/offline state; never last-writer-wins.
6. Preserve orphan recovery: a snapshot successfully inserted before a failed CAS remains immutable and can be recognized on retry.
7. Keep startup, foreground resume when available, manual check, 15-second foreground retry, pause/resume, and Windows close publication. A close-time timeout may close the app only after pending state was durably saved locally.
8. Keep fetch confirmation, local backup before replacement, branch detection, three-way merge, and explicit conflict UI unchanged except for provider-neutral wording.
9. Run checkpoint/retention only after a successful publication/check, with one complete lineage and no pending/conflict state. Publish the replacement checkpoint and pruned manifest through CAS before calling guarded deletion.
10. Do not add Realtime in this milestone. Polling and lifecycle triggers remain the source of update checks.

### Verify

Automate these cases against fake/local Supabase:

- sequential edits converge;
- simultaneous publishers preserve two heads;
- independent edits merge and publish a merge snapshot;
- same-field and delete/edit conflicts survive restart and require a choice;
- offline edit persists and publishes after reconnect;
- auth expiry pauses remote work without blocking local saves;
- snapshot success plus manifest failure recovers after restart;
- stale CAS never overwrites another head;
- malformed/future-protocol/mismatched-notebook data does not replace local data;
- more than 30 sequential publications compact safely;
- concurrent heads, pending work, missing ancestry, and conflicts prevent cleanup;
- Windows close-time publication still leaves either a confirmed remote snapshot or a durable local pending snapshot.

## Milestone 6 — Provider, security, and two-client acceptance

**Prerequisites:** Milestones 1–5 and completed Gate A. Use only a development Supabase project and disposable test users/data.

**Files:** Tests, evidence, and milestone handoff. Production code changes only for defects discovered here.

### Steps

1. Re-run pgTAP security tests and database linting against a clean local reset.
2. Use two isolated Backlogger profiles with the same Google account to simulate two devices. Each profile must have a distinct device ID and local app-data directory.
3. Verify first-profile initialization, second-profile discovery, explicit first fetch, sequential edits in both directions, concurrent offline edits, automatic merge, and manual conflict resolution.
4. Interrupt the app after every publication boundary: before snapshot RPC, after snapshot RPC/before manifest CAS, after CAS/before local sync-state save, and during cleanup. Restart and confirm recoverability.
5. Test revoked/expired session, logout during an idle state, login cancellation, wrong Google account, offline startup, throttled/transient responses, and return online.
6. Inspect Supabase rows after each test. Confirm one owner cannot query or mutate another owner's data, snapshot rows never change in place, and manifest versions increase monotonically.
7. Inspect the app-data directory, logs, portable exports, Git diff, and built bundle for forbidden secrets. The publishable key is client-visible by design; the service-role key and Google client secret must be absent.
8. Re-run all repository checks and create a Windows installer. Verify the existing Windows-specific version override remains independent from Android.

### Exit criteria

- All repository and database tests pass.
- Real Google login, session restoration, and logout are verified in a packaged Windows build.
- Two isolated clients converge without data loss through sequential, concurrent, offline, restart, and conflict cases.
- RLS and function permissions pass both allowed and denied tests.
- The old OneDrive folder was not modified.

## Milestone 7 — Remove retired folder sync and document the cutover

**Prerequisite:** Milestone 6 has passed. Do not remove rollback code/data earlier.

**Files:** `src/sync/local-folder-transport.ts`, `src/sync/transport.ts`, `src/sync.ts`, `src/main.ts`, Rust commands, tests, `README.md`, `AGENTS.md`, `.env.example`, this document.

### Steps

1. Remove the runtime `LocalFolderSyncTransport`, `OneDriveLocation`, folder path helpers, folder-picker sync UI, test-only folder environment variables, and obsolete folder-sync tests.
2. Remove native commands used only by folder sync (`ensure_directory`, optional sync-file read/list/delete helpers) after proving import/export and local notebook storage do not use them. Keep document import/export and app-data persistence commands.
3. Collapse `SyncTransportKind`/`SyncLocation` to the supported Supabase shape while keeping schema-1/2 migration parsing in a clearly marked compatibility boundary.
4. Remove OneDrive/MSAL/Graph promises from active architecture comments and `AGENTS.md`. Do not rewrite `mobile.md` or `mobile-implementation.md` in this milestone.
5. Add `.env.example` containing names/placeholders only. Explain that Vite values are bundled and therefore only the Supabase publishable key is permitted there.
6. Update the README with:
   - local mode needs no account or hosted service;
   - cloud sync is optional and currently uses Google login plus Supabase;
   - login/logout and recovery behavior;
   - local and remote development setup;
   - required migrations and environment variables;
   - warning not to put service-role or Google secrets in the app;
   - Windows build/test commands.
7. Run `rg` for `OneDrive`, `Google Drive`, `Choose folder`, `local-folder`, old test environment names, MSAL, and Graph. Remaining occurrences must be historical/migration documentation or deliberately retained compatibility parsing.
8. Run every frontend, unit, Rust, Windows packaging, local database reset, pgTAP, and security test again. Record the final installer path and results.

### Done when

- Windows offers `Log in to Sync` → `Continue with Google` and no active folder-sync path.
- Local-only mode works with no Supabase configuration or account.
- Supabase sync passes the behavior and security acceptance suite.
- The old local/OneDrive data remains available for rollback but is never touched by the new transport.
- No secrets are tracked.

### Required next action after Milestone 7

Stop before implementing further Android sync work. Remind the user to revise `mobile-implementation.md` for Supabase/Google authentication and reconcile the broader setup and safety gates in `mobile.md`. The existing OneDrive/MSAL/Graph milestones are obsolete and must not be handed to Luna after this migration.

## Standard verification commands

Run the commands relevant to every changed layer and record exact results in the handoff:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo check --manifest-path src-tauri/Cargo.toml
npm.cmd run tauri -- build --ci

# Once the local Supabase directory exists:
npx.cmd supabase db reset --local
npx.cmd supabase test db
npx.cmd supabase db lint --local
```

Android rebuild/testing is required only when a milestone changes shared Tauri configuration, Rust plugins, capabilities, deep links, or code bundled into Android. Passing an Android build does not enable Android sync; that decision belongs to the revised mobile plan.

## Official implementation references

- [Supabase Auth](https://supabase.com/docs/guides/auth)
- [Supabase Google login](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)
- [Supabase native mobile deep linking](https://supabase.com/docs/guides/auth/native-mobile-deep-linking)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase database functions and function security](https://supabase.com/docs/guides/database/functions)
- [Supabase JavaScript RPC calls](https://supabase.com/docs/reference/javascript/rpc)
- [Supabase local development workflow](https://supabase.com/docs/guides/local-development/cli-workflows)
- [Supabase database testing](https://supabase.com/docs/guides/local-development/testing/overview)
- [Tauri 2 deep linking](https://v2.tauri.app/plugin/deep-linking/)
- [Tauri 2 opener](https://v2.tauri.app/plugin/opener/)
