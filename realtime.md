# Local-first record sync implementation plan

Status: Milestones 0–1 complete; v2 contracts, validation, pure reconciliation, ordering, safety fixtures, and a dormant flag exist, but no active runtime or database behavior has changed. This plan replaces the snapshot/manifest protocol only after a verified side-by-side migration. Local-only use must continue to require no account or network.

## Current-state assessment

- The UI currently mutates one in-memory `Notebook` and persists the entire document as `backlogger.json`.
- Supabase currently stores immutable whole-notebook snapshots plus one manifest. It has notebook-level revisions, not per-category/task versions.
- Deletes remove records from the document; there are no tombstones or retained per-record bases.
- Sync is driven by debounce, polling, startup, and close handling. Supabase Realtime is not configured.
- Concurrent snapshot branches are preserved, but a newly connecting device rejects multiple branches before it can use Merge. The record protocol below removes that dead end.
- Keep the existing IDs, UI, Google/Supabase authentication, RLS ownership boundary, exports, and legacy data as migration inputs. Replace the local persistence and sync engines.

## Fixed architecture

1. Production Windows and Android use SQLite through Tauri SQL as the local database. Browser preview may use a test/localStorage adapter behind the same repository interface.
2. UI code calls only the local repository. It never calls Supabase. A successful local transaction updates the visible UI immediately and queues durable background work.
3. Supabase is canonical for acknowledged shared state. Unsynced local rows and the outbox remain authoritative until acknowledged; network failure never blocks editing.
4. Realtime is a low-latency wake-up signal, not the correctness mechanism. Startup, reconnect, focus/resume, periodic safety checks, and every Realtime event run an idempotent delta pull.
5. App-level deletion is always a soft delete. Subscribe to `INSERT`, `UPDATE`, and `DELETE`, but normal deletes arrive as `UPDATE` events carrying `deleted_at`. Do not physically purge tombstones in the first release.
6. Retain the legacy JSON and Supabase snapshot tables untouched through rollout. Never dual-write old and new protocols after a device completes cutover.

## Record contract

Synced category business fields: `id`, `name`, `sort_key`.

Synced task business fields: `id`, `category_id`, `title`, `scheduled_dates`, `deadline_date`, `sort_key`.

Every category/task also has:

- `notebook_id` and `owner_id` remotely;
- `updated_at` as the latest business-field edit time;
- `version` as the last server-accepted integer version;
- nullable `deleted_at` tombstone time;
- `updated_by_device_id` for deterministic timestamp ties;
- `field_updated_at`, an allow-listed map of business field to `{ at, deviceId }` so a later edit to one field cannot incorrectly win a conflict on another field;
- server-assigned `change_seq`, drawn from one sequence shared by both record tables and their change ledger, for lossless cursor-based catch-up. Sequence gaps are allowed; ordering must not depend on timestamps.

Local SQLite additionally stores:

- a base copy of every last-acknowledged record, including its version and field clocks;
- one coalescing outbox row per dirty record with attempt/error metadata;
- sync metadata: device ID, account/project/notebook binding, last applied `change_seq`, state, and last error;
- local-only preferences and bounded recovery backups. None of these enter portable exports or Supabase records.

Use stable string IDs already present in Backlogger. Render active rows by `sort_key`, then `id` as a deterministic tie-breaker. Implement/test one rank helper for insertion and drag reorder; never infer order from timestamps.

## Reconciliation rules

Compare `base`, `local`, and `server` for one record at a time:

| Condition | Result |
|---|---|
| Only local differs from base | Upload local using base/server `version` as the expected version. |
| Only server differs from base | Apply server locally and replace the base. |
| Both changed different fields | Combine the independently changed fields. |
| Both changed the same field to the same value | Keep the value and newest field clock. |
| Both changed the same field differently | Keep the value with the newer field clock; tie-break by `deviceId`. |
| Either side deleted while the other edited | Deletion wins; retain/publish the tombstone. |
| Category is deleted | Hide the category and its tasks immediately; queue task tombstones without allowing stale task edits to restore it. |

After any merge, save the merged row and outbox intent in one local transaction. Send a mutation with `expected_version`. The server either accepts it, increments `version`, assigns `change_seq`, and returns the canonical row, or returns the current row as stale. On stale, reconcile again and retry a bounded three times. Never overwrite without a matching version.

`scheduled_dates` is one field for conflict purposes. Import, category deletion, and reordering may update several records but must use one local SQLite transaction. A clock more than five minutes in the future is invalid; document that same-field latest-edit behavior otherwise assumes reasonably correct device clocks.

## Instructions for each milestone agent

- Implement only the assigned milestone and read all earlier handoffs first.
- Preserve unrelated changes, `local.backlogger.desktop`, the Windows app-data location, and independent Windows/Android versions.
- Add focused modules; do not move the new repository, merge engine, transport, or Realtime lifecycle into `src/main.ts`.
- Do not run Supabase migrations, resets, links, pushes, or database tests. Prepare them and stop at the stated user gate.
- Do not commit. Append a short `### Milestone N handoff` with changed files, tests, runtime evidence, remaining manual actions, and stable interfaces.
- Keep the old protocol operational behind a feature flag until the cutover milestone explicitly changes the default.

## Milestone 0 — Freeze contracts and safety fixtures

**Prerequisites:** none.

1. Add pure TypeScript record, field-clock, mutation, acknowledgement, cursor, and sync-state types under `src/sync-v2/`.
2. Define schema validators for all local/remote rows. Reject unknown record types, invalid dates, invalid versions, future clocks, wrong notebook/account IDs, and malformed field-clock keys.
3. Add synthetic legacy fixtures covering one snapshot head, multiple complete heads, an orphan snapshot, and missing ancestry. Do not copy private task contents into Git.
4. Add a disabled-by-default `recordSync` capability/feature flag. Existing runtime behavior must remain unchanged.

**Verify:** existing checks remain green; validator/fixture tests pass; no database or UI behavior changes.

**Done when:** all later milestones share one explicit contract and can run without accessing a real account.

### Milestone 0 handoff

- Added the stable `src/sync-v2/index.ts` boundary, exporting discriminated category/task records, exact per-field clocks, local/remote identities, OCC mutation acknowledgements, the change cursor, sync state, and strict parsers.
- Validators reject unknown types and fields, malformed/missing field clocks, invalid or noncanonical dates/timestamps, clocks over five minutes ahead, invalid local/remote versions and sequences, inconsistent mutation envelopes, and wrong notebook/account/project bindings.
- Added synthetic legacy graph fixtures for one head, two complete heads, an unlisted orphan leaf, and missing ancestry. Fixtures contain only invented category/task data.
- Added `platformCapabilities().recordSync`, backed by the compile-time `RECORD_SYNC_ENABLED = false`; no UI, storage, Supabase, or active sync module imports the v2 boundary.
- Verification on 2026-09-12: `npm.cmd run check`, all 58 `npm.cmd test` tests, `npm.cmd run build`, and `git diff --check` pass. No provider or real account was accessed. Manual actions: none.
- Remaining work starts at Milestone 1: implement only the pure merge/ordering engine against these exported contracts; do not enable `recordSync`.

## Milestone 1 — Pure merge and ordering engine

**Prerequisite:** Milestone 0.

1. Implement three-way field comparison exactly as specified above. Keep metadata out of business-field comparisons.
2. Implement field-clock comparison, deterministic device-ID ties, version handling, deletion dominance, and category-delete cascading decisions.
3. Implement stable `sort_key` generation and deterministic collision fallback. Reordering remains limited to a task's category.
4. Make every operation pure and idempotent. Applying the same server row or Realtime event twice must be a no-op.

**Verify:** table-driven tests cover every rule in both local/server directions, multiple fields, equal timestamps, clock rejection, delete/edit, parent deletion, duplicate/out-of-order input, and order collisions.

**Done when:** reconciliation decisions require no UI, SQLite, or Supabase code.

### Milestone 1 handoff

- Added pure `src/sync-v2/merge.ts` reconciliation. `reconcileRecord(base, local, server, options)` returns the local row, newest acknowledged base, OCC `expectedVersion`, explicit action, and fields still requiring upload without mutating its inputs.
- Field changes are compared against the base using business values and their allow-listed field clocks; generic version/sequence metadata never creates an upload. Concurrent independent fields combine, same-field conflicts use canonical timestamps then device ID, and `scheduledDates` remains one atomic field.
- Tombstones dominate edits as complete rows in both directions. `cascadeCategoryTombstones` deterministically returns only active children requiring tombstones and is idempotent, so a stale task edit cannot restore a deleted category.
- `applyServerRecord` accepts only forward canonical version/sequence progress, returns exact duplicates and older ordered events as no-ops, and rejects contradictory canonical rows.
- Added pure `src/sync-v2/ordering.ts` helpers: evenly spaced fixed-width ranks, midpoint insertion, automatic deterministic rebalance when rank space is exhausted/invalid, `sortKey` then ID collision ordering, and category-scoped task moves only.
- Added table-driven coverage for local/server-only edits, independent and same-field changes in both directions, equal-time ties, arrays, metadata isolation, clock rejection, deletion, new rows, duplicates, out-of-order events, version/sequence contradictions, category cascades, every move direction, rank exhaustion/collisions, tombstones, and cross-category rejection.
- Verification on 2026-09-12: `npm.cmd run check`, all 74 `npm.cmd test` tests, `npm.cmd run build`, and `git diff --check` pass. `RECORD_SYNC_ENABLED` remains `false`; no UI, storage, provider, account, Rust, or database path was accessed or changed. Manual actions: none.
- Remaining work starts at Milestone 2: implement the SQLite repository and one-time legacy JSON import around these interfaces without activating the v2 runtime.

## Milestone 2 — SQLite local repository and legacy JSON import

**Prerequisite:** Milestone 1.

**Likely files:** `src/local-db/*`, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`, `package.json`, Tauri capabilities/configuration, storage tests.

1. Add Tauri SQL with SQLite and registered transactional migrations for category, task, base, outbox, sync-meta, preference, and recovery-backup tables.
2. Expose a narrow `LocalRepository` interface. Include atomic read model, create/edit/reorder/soft-delete, apply-server-row, acknowledge-mutation, outbox, base, cursor, backup, and transaction operations.
3. On first launch only, validate `backlogger.json`, create a recovery backup, import active categories/tasks with stable IDs and initial sort keys, then mark migration complete in the same SQLite transaction.
4. Never delete or rename `backlogger.json` or its backup. A failed import rolls back SQLite and leaves the current app path usable.
5. Keep a fake in-memory repository for unit tests and a browser-preview adapter; production Tauri must use SQLite.

**Verify:** clean install, populated legacy file, empty file, malformed file, duplicate IDs, interrupted migration, repeat launch, rollback, and Windows/Android database reopen tests.

**Done when:** SQLite can faithfully round-trip the current notebook and durable sync metadata without changing the active UI path.

## Milestone 3 — Route the UI through the local repository

**Prerequisite:** Milestone 2. Supabase behavior remains on the old protocol or disabled by flag.

1. Replace direct document mutation/save orchestration with repository commands. `main.ts` may retain a rendered projection, but every edit must commit locally before being considered successful.
2. Reload or patch the projection only from the committed local result. No auth/network state may disable ordinary create, edit, reorder, complete, delete, theme, or view controls.
3. Convert category/task deletion to hidden tombstones. Undo creates a new local edit; it must not erase tombstone history silently.
4. Adapt import/export: exports include active notebook content only; imports transact active upserts plus tombstones for replaced local records. Exclude bases, versions, clocks, outbox, auth, bindings, and preferences.
5. Preserve recovery, serialized writes, scroll/focus behavior, and all current Windows/Android local features.

**Verify:** all local UI flows, restart, crash after commit, backup/recovery, import replacement, undo, ordering, signed-out mode, and current test suite.

**Done when:** the UI has no direct dependency on JSON persistence or Supabase and local edits remain instant.

## Milestone 4 — Supabase record schema, OCC RPCs, RLS, and publication

**Prerequisites:** Milestones 0–1. This may be developed alongside Milestones 2–3 but cannot be marked verified before User Gate A.

1. Create a new migration; never edit the applied snapshot migration. Add `sync_v2_notebooks`, `sync_v2_categories`, `sync_v2_tasks`, an append-only `sync_v2_changes` ledger, and one shared `sync_v2_change_seq` sequence.
2. Add constraints for ownership, notebook/record IDs, dates, nonnegative versions, tombstones, allow-listed field clocks, and category/task relationships.
3. Add authenticated-owner `SELECT` policies. Revoke direct client writes; expose security-definer RPCs with fixed search paths for atomic initialization, ordered change reads, and category/task OCC mutation.
4. Each mutation RPC accepts `expected_version`. Insert requires zero/nonexistence; update requires an exact match; accepted writes increment version, allocate one `change_seq`, update the canonical row, append its full canonical payload to `sync_v2_changes` in the same transaction, and return that row. Stale writes return the current row without mutation.
5. Enable both record tables in `supabase_realtime`. Keep RLS as the visibility boundary. Subscribe to all three event types, although soft deletion normally emits `UPDATE`.
6. Add pgTAP coverage for ownership isolation, anon denial, grants, validation, initialization atomicity, stale writes, version increments, atomic change-ledger entries, ordered cursor reads, tombstones, idempotency, and publication membership.
7. Regenerate `supabase/database.types.ts` only through the user-run workflow.

### User Gate A — apply and verify the development schema

The user runs from the repository root:

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

For the disposable development project, the user then links if needed, runs `npx.cmd supabase db push --linked --dry-run`, reviews it, runs `npx.cmd supabase db push --linked`, then runs:

```powershell
npx.cmd supabase db lint --linked
cmd /c "npx.cmd supabase gen types typescript --linked > supabase/database.types.ts"
```

**Done when:** the user reports successful local and linked checks and confirms both v2 tables are in the Realtime publication. Old tables remain untouched.

## Milestone 5 — Delta pull, durable outbox, and OCC push

**Prerequisites:** Milestones 1–4 and User Gate A.

1. Add a record transport that uses only the generated public types, publishable key, authenticated user, RLS, and v2 RPCs. Never use a service-role key or email as ownership.
2. Pull `sync_v2_changes` where `seq > last_change_seq`, ordered and paginated by `seq`. Validate and apply its canonical row payloads, then advance the cursor in the same local transaction. Do not independently scan the two record tables and advance one shared cursor; a write between those scans could be skipped.
3. Drain the coalesced outbox after local commit. On acknowledgement, save the canonical row, base, version, and cursor atomically and remove only the acknowledged outbox entry.
4. On stale response, run the pure three-way merge and retry up to three times. Persist failure/attempt state without blocking editing.
5. Serialize pull/push cycles. Startup and reconnect order is: authenticate/bind, begin catch-up, pull, reconcile, push outbox, pull again.
6. Add a periodic foreground delta pull as a safety net. Do not use timestamps as cursors and do not require a close-time upload; close waits only for the current SQLite transaction because the outbox survives restart.

**Verify:** fake-transport tests cover pagination, gaps, duplicated/out-of-order rows, offline restart, stale versions, interruption before/after RPC, acknowledgement loss, bounded retry, wrong account/project, expired auth, and two clients converging without Realtime.

**Done when:** polling/reconnect alone provides correct record-level convergence and no manual branch repair is possible or required.

## Milestone 6 — Supabase Realtime lifecycle

**Prerequisite:** Milestone 5.

1. Add one authenticated channel scoped to the active notebook with handlers for both record tables and `INSERT`, `UPDATE`, and `DELETE`.
2. Subscribe first, wait for `SUBSCRIBED`, then run cursor catch-up so no fetch/subscribe gap exists. Treat channel events only as wake-ups for a serialized delta pull; never write unvalidated payloads directly into UI state.
3. Coalesce event bursts, ignore echoed/older versions idempotently, and refresh from SQLite after each committed reconciliation.
4. On channel timeout/error/close, mark Realtime degraded, continue local editing and periodic catch-up, back off reconnects, resubscribe, then pull from the stored cursor.
5. Refresh the channel JWT on auth refresh. Tear down the old channel before logout, account change, pause, sleep/background, or notebook rebinding; create only one replacement channel.
6. Resume with subscribe-plus-catch-up on focus/network recovery and Android foreground. Realtime must never be the only recovery path.

**Verify:** two-client tests measure immediate propagation and cover burst edits, echo, event-before-response, response-before-event, duplicate event, dropped socket, token refresh, sleep/resume, offline edits, process kill, and reconnect catch-up.

**Done when:** connected devices normally update within seconds and disabling Realtime changes latency only, not correctness.

## Milestone 7 — Safe legacy cloud bootstrap and protocol cutover

**Prerequisites:** Milestones 0–6 and disposable-project tests.

1. Keep login read-only. Inspect v2 first. If v2 exists, bind only to that notebook and reconcile through the new engine.
2. If v2 is absent, inspect the old manifest/snapshots without writing them. Collect every complete legacy leaf plus the validated local notebook.
3. Legacy snapshots have no tombstones, bases, or per-field clocks, so perfect historical conflict recovery is impossible. For this one-time bootstrap, explicitly tell the user and use loss-avoidance: union all complete legacy leaves and local records, resolve same-ID field differences by deterministic latest legacy snapshot time, and let the user confirm the preview.
4. If legacy ancestry is incomplete, preserve all complete leaves, report exactly which history is unavailable, and require confirmation before proceeding. Never treat missing history as empty.
5. Atomically initialize v2 records through the bootstrap RPC. Only after success save local bases/cursor, enable the v2 worker, and mark this device cut over. This directly replaces the current “resolve branches before connecting” dead end.
6. If no legacy cloud notebook exists, retain explicit `Start sync`; initialize v2 from the local SQLite notebook only after confirmation.
7. Make old snapshot/manifest code read-only migration support. Do not dual-write. Keep rollback capable of reopening the preserved JSON and old cloud data during the rollout window.
8. Replace routine Fetch/Merge branch UI with passive background sync. Keep explicit UI only for first bootstrap, account mismatch, unrecoverable data, pause/resume, logout, retry, and recovery export.

### User Gate B — bootstrap acceptance

The user exports the current notebook, confirms a backup of legacy cloud rows, and authorizes migration first on a disposable account. Test one-head, multi-head, orphan, and incomplete-history fixtures before current-user data.

**Done when:** a brand-new device can safely join an account containing any supported legacy state without manual Supabase edits or data loss.

## Milestone 8 — Windows failure testing and staged rollout

**Prerequisite:** Milestone 7 and User Gate B.

1. Run two isolated Windows profiles against the disposable project. Cover sequential edits, concurrent different-field edits, concurrent same-field edits in both timestamp orders, delete/edit, category delete/task edit, reorder collisions, offline days, and reinstall/reconnect.
2. Interrupt every boundary: local transaction, outbox save, request, server accept, local acknowledgement, delta apply, cursor save, subscribe, auth refresh, and shutdown.
3. Confirm the UI never greys out because sync is unavailable; status stays concise (`Syncing…`, `Offline`, `Sync failed`) with details accessible separately.
4. Confirm no duplicate/recreated records, lost acknowledged edit, tombstone resurrection, infinite retry, multiple active channels, or backend-repair instruction reaches the user.
5. Run repository, Rust, secret, installer, and upgrade tests. Preserve the Windows identifier/app-data path and verify migration from the currently released installer.
6. Ship behind a rollback-capable staged flag for one release. Do not drop legacy tables or JSON files.

### User Gate C — production cutover

The user applies the already-verified migration to production using the AGENTS.md dry-run/review/push workflow, regenerates linked types, deploys a build with the staged flag, and authorizes gradual enablement after backups.

**Done when:** ordinary users need no conflict buttons or backend access and two Windows devices converge under all acceptance cases.

## Milestone 9 — Android integration and plan reconciliation

**Prerequisites:** Windows Milestone 8 is stable; Android login/lifecycle gates are satisfied.

1. Use the same SQLite schema, repository, merge engine, Supabase transport, cursor, and Realtime manager on Android. Do not create a second protocol or native Supabase client.
2. Verify deep-link login, token/channel refresh, foreground/background teardown, process death, network switching, and durable outbox recovery on emulator and physical arm64 device.
3. Keep local-only mode fully functional. Android background delivery is best-effort; foreground subscribe-plus-catch-up is the correctness boundary.
4. Revise `mobile-implementation.md` so its snapshot/polling milestones are replaced by this verified record/Realtime architecture before assigning further mobile implementation.

**Done when:** Windows and Android share one record protocol and converge after live, offline, lifecycle, and reinstall tests.

## Deferred cleanup

Only after at least one stable release and explicit user approval: remove old snapshot UI/code, create a separate migration to retire legacy RPCs/tables, and define a tombstone garbage-collection policy that forces devices older than the retention watermark through a full rebase. Until then, keep tombstones and legacy backups.

## Primary references

- [Supabase Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Supabase Realtime subscriptions](https://supabase.com/docs/guides/realtime/subscribing-to-database-changes)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Tauri SQL plugin](https://v2.tauri.app/plugin/sql/)
