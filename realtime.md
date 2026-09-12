# Local-first record sync implementation plan

Status: Milestones 0–5 are implemented on Windows. The UI commits through the SQLite-backed local repository; record sync remains disabled while the existing Supabase snapshot protocol consumes only committed local projections. Local-only use requires no account or network.

## Implemented baseline

- Record contracts, strict validators, merge logic, deterministic ordering, and legacy graph fixtures live under `src/sync-v2/`.
- Windows UI reads and writes through `LocalRepository`; transactions are serialized and the visible projection updates only after a durable commit.
- SQLite stores categories, tasks, acknowledged bases, a coalescing outbox, sync metadata/cursor, local preferences, and bounded recovery backups.
- Synced records use stable IDs, per-field clocks, `updated_at`, `updated_by_device_id`, `version`, `deleted_at`, `sort_key`, and server-assigned `change_seq`.
- Three-way reconciliation uploads local-only changes, applies server-only changes, merges different fields, resolves the same field by clock then device ID, and makes deletion win over edits.
- Category deletion cascades task tombstones. Import replacement and undo preserve tombstone history; portable exports contain active categories/tasks and revision only.
- The original JSON file and legacy Supabase snapshot tables remain untouched migration inputs. Never dual-write after cutover.
- `platformCapabilities().recordSync` remains disabled until the explicit cutover milestone.

## Execution rules

- Keep sync-v2 repository, merge, transport, and Realtime lifecycle logic out of `src/main.ts`.
- Never use timestamps as the change cursor and never let auth or network failure block local editing.
- The user runs all Supabase migrations, resets, links, pushes, type generation, and database tests manually.
- Do not commit. Preserve `local.backlogger.desktop`, the Windows app-data location, unrelated changes, and the old protocol until cutover.

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

### Milestone 4 implementation handoff

- Added `20260913010000_create_sync_v2_records.sql` with v2 notebooks, categories, tasks, the shared sequence, append-only change ledger, RLS, Realtime publication, initialization, ordered cursor reads, and category/task OCC RPCs.
- Added `sync_v2_records.test.sql` covering ownership, grants, validation, atomic initialization, cursor ordering, stale writes, versioning, idempotency, tombstones, and publication membership.
- The user completed User Gate A and regenerated `supabase/database.types.ts` from the applied v2 schema.

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

### Milestone 5 implementation handoff

- Added a generated-type Supabase record transport using only authenticated v2 delta and OCC RPCs, with strict binding/payload validation and sanitized failures.
- Added a serialized worker that performs pull–push–pull catch-up, atomically reconciles delta pages with their cursor, drains the durable outbox, retries stale writes three times, and retains failures for restart recovery.
- Added foreground polling and in-transaction account/project/notebook guards; record sync remains disabled until cutover.
- Verified pagination, gaps, duplicates, ordering, offline restart, lost acknowledgements, stale retries, auth/binding failures, serialized cycles, and two-client polling convergence.

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
