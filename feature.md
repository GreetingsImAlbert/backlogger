# Cloud-folder sync — implementation plan

Status: sync remains experimental following a two-device stale-data incident. Milestone 5 is implemented in the current working tree; provider acceptance and retention stress checks remain before release.

The milestone 5 behavior below supersedes the earlier continuous publication, automatic background application, and automatic merging requirements wherever they conflict. Earlier sections describe the original design, not a guarantee that every reliability requirement has been verified.

This document specifies the sync feature from FEATURES.md. Windows desktop is the first target. Pinning and the mobile app remain separate features.

## 1. Outcome

Connect Backlogger to a folder on this computer that OneDrive or Google Drive for desktop already synchronizes. Changes save locally immediately, publish once when the session closes, and are fetched on startup or through an explicit update action on another connected computer.

Backlogger uses the provider's desktop client for account login and cloud transfer. There is no Backlogger account, hosted database, embedded provider login, or direct cloud API integration in this version. Selecting a normal local folder alone does not make it cloud-connected.

Sync operates while Backlogger is open and catches up when it launches again. The provider may continue transferring published files after Backlogger closes. There is no background Backlogger service in this version.

## 2. Setup and minimal interface

Add `Sync…` to the existing top-right menu. Its small dialog contains:

- `Choose folder`: a native folder picker.
- The connected folder, a short status, and last successful local folder check.
  - `Check for updates`, `Pause`, and `Disconnect`.
- `Resolve conflicts` only when attention is needed.

On the first computer:

1. Install/sign into the chosen provider's desktop client if needed.
2. Choose a dedicated folder inside its local OneDrive or Google Drive location.
3. Backlogger previews that the current backlog will be shared through that folder.
4. Connect to create a uniquely identified notebook and publish its initial snapshot.

On the second computer:

1. Let the provider download the same folder.
2. Select it in Backlogger and preview its categories/task count.
3. If the local list is empty, confirm joining. If it contains tasks, explicitly choose to use the shared notebook after making a local backup, or cancel and choose a different folder. Do not silently combine unrelated notebooks.

If a folder appears empty on a second computer, offer `Wait for existing notebook` separately from `Create new notebook`. Partially delivered files must not be treated as a new notebook. Conflicting initialization manifests stop setup and require selecting the intended notebook.

Normal operation adds no permanent banner to the task list. Errors and unresolved conflicts remain visible. Labels distinguish `Saved locally`, `Folder updated`, `Folder unavailable`, and `Conflicts`; a local write cannot prove that the provider uploaded it or that another device received it. Explain that limitation in the sync dialog, not on every task.

## 3. Provider prerequisites

The connected folder should be kept available offline on each computer:

- OneDrive: select `Always keep on this device` for the folder. [Microsoft documentation](https://support.microsoft.com/en-us/office/save-disk-space-with-onedrive-files-on-demand-for-windows-0e6860d3-d9f3-4971-b321-7092438fb38e).
- Google Drive for desktop: use mirrored files or mark the streamed folder available offline. [Google documentation](https://support.google.com/drive/answer/13401938?hl=en).

The app must tolerate unavailable placeholders, a stopped desktop client, a missing drive, paused transfer, and read-only folders. Do not claim provider login or remote upload success from filesystem access alone. These folders contain readable task data governed by the user's provider account and sharing settings; the first connection explains that succinctly.

## 4. Reliability prerequisites and export repair

Complete these before enabling automatic exchange:

- Replace desktop Export's browser download technique with a native Save dialog and native file write. Only report success after the write succeeds; cancellation is neutral. Retain the browser fallback for development.
- Verify desktop Import end to end with a native Open dialog, validation, preview, confirmation, and a recoverable backup before replacement.
- Strengthen local saving: the current native implementation deletes the primary before renaming a temporary file, validates only JSON syntax, and silently falls back to a backup. Implement appropriate Windows replacement, full document validation, and explicit recovery while preserving damaged originals.
- Serialize all local commits, import/recovery actions, and sync merges through one persistence coordinator. Persist notebook state and sync bookkeeping together before acknowledging changes.
- Prevent edits during initial loading. Prevent native close from discarding a pending local commit; a cloud transfer is not required before closing once local data and pending publication are durable.

This also corrects the earlier release claim: browser export status and native compilation were not proof that desktop export wrote a usable file.

## 5. Storage and exchange design

Keep the primary notebook, backups, device identity, and sync configuration in the per-user app-data directory. The cloud folder is an exchange location, not the live primary file.

Use versioned, immutable snapshots with unique IDs instead of repeatedly overwriting a shared `backlogger.json`:

```text
Chosen folder/
  backlogger-sync/
    notebook.json
    snapshots/
      <unique-snapshot-id>.json
```

The notebook manifest identifies the notebook and protocol version. Each snapshot includes the notebook ID, snapshot ID, originating device ID, parent snapshot IDs, and complete task/category data. Parents describe which versions an edit follows. Timestamps are informational and never decide which edit wins.

Store pending publications locally before attempting folder writes. Write temporary files in the exchange directory, flush them, then publish under the final unique name. Never overwrite a published snapshot. Receiving devices validate complete records and required ancestry before applying them; partial or out-of-order arrivals wait for a later scan.

Each device gets its own persistent random ID, excluded from portable exports. Deduplicate by snapshot ID and verify duplicate contents; a provider-renamed copy must not apply twice, and different content under the same ID is an error. Persist processed versions so restart does not replay changes or cause an export/import loop.

Task/category IDs remain stable. Enforce globally unique task IDs for movement across categories. Existing v1 documents migrate with a backup; do not silently rewrite duplicate IDs in shared data. Theme, selected view, device name, folder path, and future always-on-top preference stay device-local.

Milestone 5 adds bounded snapshot retention with versioned checkpoint support for long-offline devices (see below). Cleanup is enabled only for one validated, unbranched history; protected branches and unresolved ancestry remain untouched.

## 6. Automatic behavior

- After each committed edit: save locally. Do not publish an exchange snapshot until the session closes or the user explicitly resolves a sync conflict.
- Fetch/check on startup, resume/focus, `Check for updates`, and approximately every 15 seconds while open. A folder watcher may reduce latency; polling remains the fallback.
- Run only one sync cycle at a time. Back off repeated filesystem failures and retry without blocking editing.
- Read and validate remote history without changing the visible notebook during polling. Apply a single unambiguous update only through the startup fetch or an explicit Fetch action; use the Sync dialog for branches/conflicts.
- Do not replace an open editor's draft or unpublished local edits without an explicit replacement confirmation. Defer application affecting that record and recheck its base version when the user saves or cancels.
- Never infer task deletion from a missing exchange file or unavailable folder.
- Pause suspends folder activity but continues local saves. Resume catches up. Disconnect preserves local tasks and leaves provider files untouched. Reconnecting to the same notebook retains history and pending edits; switching notebooks requires an explicit join decision.

## 7. Conflict handling

Use ancestry and the common prior snapshot, not file modification time or the current single-device revision counter:

| Situation | Result |
| --- | --- |
| Remote snapshot follows the local version, no new local edits | Apply automatically |
| Local version follows the received snapshot | Keep current data; received version is older |
| Concurrent additions with distinct IDs or edits to different records/fields | Merge automatically |
| Same field changed to the same value | Accept once |
| Same field changed differently | Ask which value to keep |
| Task deleted on one device and edited on another | Explicit delete/keep conflict |
| Category deleted while another device adds/moves/edits tasks inside it | Explicit conflict; preserve affected tasks until resolved |
| Concurrent incompatible ordering or moves | Ask which ordering/destination to keep |

For the first version, scheduled-date sets and sibling order lists count as whole fields. Do not guess how to combine conflicting reorderings or date-set edits. Missing records in descendants represent deletion relative to retained ancestry, preventing an older snapshot from resurrecting them.

Show concise local/other-device values with `Keep mine` and `Use other`. Keep unresolved versions durable across restart. A resolution publishes a new snapshot referencing both branches so every device can recognize the decision. If additional remote edits arrive before resolution, recheck the conflict against the new heads.

Manual Import while connected requires a preview explaining that replacement will also propagate to connected devices. Treat it as a new local change with current ancestry; do not import device identity or reset shared history. Undo and backup restoration similarly create new changes.

## 8. Implementation milestones

| Milestone | Deliverable | Exit check | Status |
| --- | --- | --- | --- |
| 1 — Native files and local reliability | Repair Export/Import and safe local persistence | Native export/import round-trip; cancellation, failed writes, damaged data, and pending-close tests | Complete |
| 2 — Connect and publish | Folder dialog, notebook identity, durable pending snapshots, pause/disconnect | First connection and restart tested with isolated temporary folders | Complete |
| 3 — Fetch and reconcile | Ancestry comparison, automatic merging, durable conflicts, editor protection | Two simulated devices converge through offline and concurrent edits | Complete |
| 4 — Provider and desktop verification | Exercise the actual provider-backed folder, finish minimal UI, build next installer | Native two-device checks and honest status reporting pass | In progress |
| 5 — Fetch on open, publish on close | Startup editing lock, local autosave, update notifications with Fetch/Ignore, safe close publication, versioned checkpoint retention | Startup, delayed delivery, ignored updates, offline close, retention, and two-device divergence checks pass | In progress |

Update PROGRESS.md after each bounded milestone. Do not claim sync complete after one-way export or browser-only tests.

## 9. Acceptance tests

- A task created, edited, moved, reordered, or deleted on A appears correctly on B after file delivery; empty categories survive.
- Offline edits survive restart and reconcile when the folder returns.
- Replayed, duplicated, renamed, partially written, and out-of-order files do not corrupt or duplicate tasks.
- Concurrent same-field changes and delete/edit conflicts remain recoverable and resolve consistently on both devices.
- Crashes between local save, publication, and acknowledgement cause neither lost changes nor duplicate application.
- Permission failures, full disks, cloud placeholders, unsupported schemas, invalid IDs/dates, missing parents, and disappearing folders preserve local data and offer retry.
- Incoming changes cannot discard an active editor's unsaved draft.
- Theme and local settings do not change because another device changed its preferences.
- Imported/recovered content is backed up and propagated only under the explicit replacement workflow.
- Desktop export produces a real JSON file; importing it into an isolated profile restores its task data.
- At least one end-to-end run on each claimed provider is recorded. Untested provider/device combinations are labeled as such.

## 10. Human setup and boundaries

Actual provider verification needs the user to sign into the desktop sync client and select the intended folder; account credentials never belong in the project. A second computer is needed to verify actual cross-device delivery. Automated tests should use isolated profiles and exchange folders first.

Direct OneDrive/Google Drive API login, mobile filesystem integration, background services, and shared multi-user permissions are outside this first implementation. Limited history compaction is now included in milestone 5 to support snapshot retention. The snapshot protocol should remain transport-independent so a future mobile client can exchange the same data through a suitable mobile transport.

## 11. Milestone 5 — Predictable session-based syncing

Requested 2026-09-07 after the user manually recovered their backlog. Implementation started 2026-09-07; provider-backed acceptance remains open.

### Visible status at the top

- Move save/sync status and actionable notices into a compact area directly below the app title and view controls, above the task list. Remove the bottom status placement.
- Keep this header/status area visible while the task list scrolls, including at the minimum window size. Let notices wrap without covering tasks or hiding their action buttons.
- Show short states such as `Fetching…`, `Saved locally`, `Offline`, and `Shared update available`. Put Fetch/Ignore or Retry beside the relevant notice. Keep technical details and the folder path in the Sync dialog.
- Prioritize failures and updates over routine success messages; local autosave must not erase a pending update notice. Use accessible status announcements without repeatedly announcing unchanged polling results.

### Snapshot retention

- Default to retaining the latest **30 completed recovery snapshots per shared notebook** across devices. Keep the limit fixed for this milestone to avoid adding settings clutter.
- Protect current shared heads, unresolved branches/conflicts, pending publications, and any snapshots still required to validate them. These may temporarily exceed the 30-snapshot target; never delete unresolved work merely to satisfy the count.
- Add a versioned, self-contained checkpoint and the minimum history metadata needed to recognize superseded versions and retained branches. Validate and publish the checkpoint before pruning older snapshot payloads. Do not simply delete the oldest files: the current reader requires complete parent ancestry.
- A returning device whose accepted base was pruned must fetch the checkpoint. Preserve unpublished local work and require an explicit replacement decision if it cannot be safely related to the checkpoint; never republish an old notebook automatically.
- Plan cleanup after successful publication, with one device coordinating each cleanup and revalidation before deletion. Cleanup is best-effort and must tolerate concurrent publication, partial provider delivery, interrupted deletion, and duplicate files. Keep local backups separate from shared retention.
- Require checkpoint-compatible clients on both devices before enabling pruning. Older clients must reject the new protocol safely rather than interpret pruned history as an empty notebook. Surface retention waiting for unresolved history in the Sync dialog if the target cannot yet be reached.
- Order retained recovery history by validated lineage; timestamps may order recovery entries for display but must not decide which concurrent branch wins.

### On opening the app

1. Load the local notebook and show it read-only with a small `Fetching…` status. Disable task/category mutations, Import, Undo, and other notebook replacement actions during the fetch.
2. Read and validate the shared snapshots available in the local provider folder. Apply the latest unambiguous descendant of the last accepted shared version before enabling editing. Back up local content before replacement.
3. If the local notebook contains unpublished changes from an earlier session, preserve them. Do not silently replace them or publish them as though they incorporate remote changes. When both sides changed, use the explicit choice described below.
4. If the folder is unavailable, incomplete, or the check exceeds a bounded timeout, offer `Retry` or `Continue offline`. Continue offline enables editing of the locally saved notebook and resumes periodic detection. Never interpret a missing file as an empty notebook.
5. If the folder is readable but OneDrive has not delivered a newer snapshot yet, the app may only see an older version. Finish the local check and enable editing; later detection handles newly delivered files. Filesystem access cannot prove that the provider has finished downloading.

### While the app is open

- Keep automatic local saving after each edit for crash protection. Do not publish an exchange snapshot after each edit.
- Approximately every 15 seconds, and on focus/resume, check for newly available complete shared versions. These are read-only checks: they neither replace the visible notebook nor publish local edits.
- When a new version becomes available, show one compact in-app notice: `Shared update available` with `Fetch` and `Ignore`.
- `Fetch` temporarily disables editing, validates the version again, backs up the current notebook, and applies it. If there are local changes or an open draft, explain that fetching replaces those changes and require an explicit replacement decision; Cancel keeps them. Preserve the draft until that decision is made.
- `Ignore` dismisses the notice for that exact version for this session. It does not delete the remote data, mark it incorporated, or authorize overwriting it. A different newly delivered version can trigger another notice. The ignored version remains available through a manual Fetch action and is reconsidered on the next launch.
- Do not silently merge or apply remote edits during a session. Use the separate `Check for updates` and `Fetch` actions.

### On closing the app

1. Handle native window close explicitly. Temporarily disable editing and finish all pending local writes.
2. If task/category content changed, persist one pending snapshot locally and attempt to publish it to the exchange folder. Closing without content changes creates no new snapshot. Theme/view changes are local only.
3. Recheck the available shared versions before publication. Publish automatically only when the session's accepted base is still current; never attach unseen shared versions as parents of old local content.
4. If another device changed the notebook, including an ignored update, preserve both versions and offer `Fetch shared version`, `Keep my version`, or `Cancel close`. Fetch backs up local changes before replacement. Keep my version explicitly confirms replacing the shared content with the local notebook while retaining history. Cancel leaves the app open. If the shared version changes again during the decision, recheck instead of silently overwriting it.
5. If the folder write fails, retain the notebook and pending publication durably, and offer `Retry` or `Close with local copy`. The next launch fetches/checks before retrying publication; a stale queued snapshot never wins automatically.
6. Close after the local commit and successful folder publication, or the explicit local-only close choice. Do not wait for OneDrive upload completion, which the app cannot verify through folder access.

### Version and safety rules

- Define latest by validated shared history and the accepted session base. File timestamps and per-device revision counters do not establish which notebook content is newer across devices.
- When there are multiple concurrent heads, there is no single latest version: request an explicit choice, retain both, and do not pick by timestamp.
- Remove the automatic fallback that replaces the notebook with a leaf chosen by time when the current snapshot is missing. Missing ancestry or questionable legacy history requires retry/recovery, preserving local data.
- Retain immutable snapshots and backups for recovery. A sync snapshot import restores content without replacing device identity or falsely rewriting accepted ancestry.
- Pause stops folder reads/writes while local saving continues. Disconnect keeps local content and shared history. Neither bypasses the next connection's fetch-before-publication checks.
- Cloud delivery can race a close-time check. Preserve concurrent branches and detect them on the next scan; no folder-only design can guarantee awareness of files the provider has not delivered yet.

### Exit checks

- Status and Fetch/Ignore remain visible at the top while scrolling a long backlog and at the minimum window size. Routine saves never dismiss an update/error notice.
- After more than 30 sequential publications, cleanup retains 30 recovery snapshots plus only protected history/checkpoint metadata; both devices still fetch correctly.
- Test interrupted cleanup, concurrent publication, unresolved branches, and a device returning with a pruned base and unpublished changes. No local work is silently lost or resurrected.
- Opening Device B fetches A's available latest version with editing disabled and creates no stale publication.
- Delayed OneDrive delivery after startup produces Fetch/Ignore; the visible list stays unchanged until Fetch is chosen.
- Ignore suppresses repeated prompts for that version within the session, allows a later version to notify, and never grants overwrite permission on close.
- Local edits survive a crash, failed folder write, and restart. Startup checks remote history before retrying a pending publication.
- Closing after edits publishes once; closing with no content changes publishes nothing.
- Remote changes discovered on close and concurrent branches require an explicit choice; both versions remain recoverable.
- Fetch never discards an active draft or unpublished changes without an explicit replacement decision and backup.
- Missing parents, malformed files, provider pauses, and unavailable folders preserve local data and provide actionable status.
- Repeat the user's A-current/B-stale scenario with a real OneDrive folder, then record provider/device results in PROGRESS.md before declaring this milestone complete.
