begin;

select plan(37);

select ok(to_regclass('public.sync_notebooks') is not null, 'sync_notebooks table exists');
select ok(to_regclass('public.sync_snapshots') is not null, 'sync_snapshots table exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sync_notebooks'::regclass),
  'RLS is enabled for sync_notebooks'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sync_snapshots'::regclass),
  'RLS is enabled for sync_snapshots'
);
select ok(has_table_privilege('anon', 'public.sync_notebooks', 'SELECT'), 'anon has only the read entry point');
select ok(has_table_privilege('authenticated', 'public.sync_notebooks', 'SELECT'), 'authenticated can read notebooks');
select ok(
  not has_table_privilege('authenticated', 'public.sync_notebooks', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sync_notebooks', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.sync_notebooks', 'DELETE'),
  'authenticated cannot mutate notebooks directly'
);
select ok(
  not has_table_privilege('authenticated', 'public.sync_snapshots', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sync_snapshots', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.sync_snapshots', 'DELETE'),
  'authenticated cannot mutate snapshots directly'
);
select ok(not has_function_privilege('anon', 'public.create_sync_snapshot(text, text, jsonb)', 'EXECUTE'), 'anon cannot execute write functions');

-- Local database tests create two real auth identities, then simulate JWT claims
-- exactly as the API does. These rows are rolled back with the test transaction.
set local role postgres;
insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'sync-a@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'sync-b@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
on conflict (id) do nothing;

set local role anon;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"anon"}', true);
select is((select count(*) from public.sync_notebooks), 0::bigint, 'anonymous users see no notebooks');
select is((select count(*) from public.sync_snapshots), 0::bigint, 'anonymous users see no snapshots');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);

select lives_ok($sql$
  select * from public.initialize_sync_notebook(
    'notebook-a',
    'checkpoint-a',
    '{"protocolVersion":1,"type":"checkpoint","checkpointVersion":1,"snapshotId":"checkpoint-a","notebookId":"notebook-a","deviceId":"device-a","parentSnapshotIds":[],"createdAt":"2026-09-10T00:00:00.000Z","revision":0,"categories":[]}'::jsonb,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-a","createdAt":"2026-09-10T00:00:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["checkpoint-a"],"prunedSnapshotIds":[]}'::jsonb
  )
$sql$, 'initialization stores a notebook and checkpoint atomically');
select is((select manifest_version from public.sync_notebooks where notebook_id = 'notebook-a'), 1::bigint, 'initial manifest version is one');
select is((select count(*) from public.sync_snapshots where notebook_id = 'notebook-a'), 1::bigint, 'initial checkpoint is stored');

select throws_ok($sql$
  select * from public.initialize_sync_notebook(
    'notebook-b',
    'checkpoint-b',
    '{"protocolVersion":1,"type":"checkpoint","checkpointVersion":1,"snapshotId":"checkpoint-b","notebookId":"notebook-b","deviceId":"device-a","parentSnapshotIds":[],"createdAt":"2026-09-10T00:00:00.000Z","revision":0,"categories":[]}'::jsonb,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-b","createdAt":"2026-09-10T00:00:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["checkpoint-b"],"prunedSnapshotIds":[]}'::jsonb
  )
$sql$, '23505', 'notebook already exists', 'one user can initialize only one notebook');

select throws_ok($sql$
  select * from public.initialize_sync_notebook(
    'notebook-invalid',
    'snapshot-invalid',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"snapshot-invalid","notebookId":"notebook-invalid","deviceId":"device-a","parentSnapshotIds":[],"createdAt":"2026-09-10T00:00:00.000Z","revision":1,"categories":[]}'::jsonb,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-invalid","createdAt":"2026-09-10T00:00:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["snapshot-invalid"],"prunedSnapshotIds":[]}'::jsonb
  )
$sql$, '22023', 'initial snapshot is not a protocol v1 checkpoint', 'invalid initialization is rejected');
select is((select count(*) from public.sync_notebooks where notebook_id = 'notebook-invalid'), 0::bigint, 'invalid initialization leaves no notebook behind');

select is(
  (select status from public.create_sync_snapshot(
    'notebook-a',
    'snapshot-a',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"snapshot-a","notebookId":"notebook-a","deviceId":"device-a","parentSnapshotIds":["checkpoint-a"],"createdAt":"2026-09-10T00:01:00.000Z","revision":1,"categories":[]}'::jsonb
  )),
  'created',
  'new snapshots are inserted'
);
select is(
  (select status from public.create_sync_snapshot(
    'notebook-a',
    'snapshot-a',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"snapshot-a","notebookId":"notebook-a","deviceId":"device-a","parentSnapshotIds":["checkpoint-a"],"createdAt":"2026-09-10T00:01:00.000Z","revision":1,"categories":[]}'::jsonb
  )),
  'already-identical',
  'replaying an identical snapshot is idempotent'
);
select throws_ok($sql$
  select * from public.create_sync_snapshot(
    'notebook-a',
    'snapshot-a',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"snapshot-a","notebookId":"notebook-a","deviceId":"device-a","parentSnapshotIds":["checkpoint-a"],"createdAt":"2026-09-10T00:02:00.000Z","revision":2,"categories":[]}'::jsonb
  )
$sql$, 'P0001', 'snapshot id already contains different immutable content', 'different content cannot overwrite an immutable snapshot');

select is(
  (select applied from public.compare_and_swap_sync_manifest(
    'notebook-a',
    1,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-a","createdAt":"2026-09-10T00:03:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["snapshot-a"],"prunedSnapshotIds":[]}'::jsonb
  )),
  true,
  'matching manifest version applies the CAS'
);
select is((select manifest_version from public.sync_notebooks where notebook_id = 'notebook-a'), 2::bigint, 'successful CAS increments the manifest version');
select is(
  (select applied from public.compare_and_swap_sync_manifest(
    'notebook-a',
    1,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-a","createdAt":"2026-09-10T00:04:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["checkpoint-a"],"prunedSnapshotIds":[]}'::jsonb
  )),
  false,
  'stale manifest version does not overwrite'
);
select is((select manifest -> 'headSnapshotIds' ->> 0 from public.sync_notebooks where notebook_id = 'notebook-a'), 'snapshot-a', 'stale CAS preserves the current manifest');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000002","role":"authenticated"}', true);
select is((select count(*) from public.sync_notebooks), 0::bigint, 'a second user cannot read the first user notebook');
select lives_ok($sql$
  select * from public.initialize_sync_notebook(
    'notebook-b',
    'checkpoint-b',
    '{"protocolVersion":1,"type":"checkpoint","checkpointVersion":1,"snapshotId":"checkpoint-b","notebookId":"notebook-b","deviceId":"device-b","parentSnapshotIds":[],"createdAt":"2026-09-10T00:05:00.000Z","revision":0,"categories":[]}'::jsonb,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-b","createdAt":"2026-09-10T00:05:00.000Z","createdByDeviceId":"device-b","headSnapshotIds":["checkpoint-b"],"prunedSnapshotIds":[]}'::jsonb
  )
$sql$, 'the second user can initialize only their own notebook');
select is(
  (select status from public.create_sync_snapshot(
    'notebook-b',
    'b-snapshot',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"b-snapshot","notebookId":"notebook-b","deviceId":"device-b","parentSnapshotIds":["checkpoint-b"],"createdAt":"2026-09-10T00:06:00.000Z","revision":1,"categories":[]}'::jsonb
  )),
  'created',
  'the second user can publish their own snapshot'
);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
select is((select count(*) from public.sync_notebooks where notebook_id = 'notebook-b'), 0::bigint, 'the first user cannot read the second user notebook');
select throws_ok($sql$
  select * from public.create_sync_snapshot(
    'notebook-b',
    'other-user-snapshot',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"other-user-snapshot","notebookId":"notebook-b","deviceId":"device-a","parentSnapshotIds":[],"createdAt":"2026-09-10T00:07:00.000Z","revision":1,"categories":[]}'::jsonb
  )
$sql$, '42501', 'notebook is not owned by the authenticated user', 'the first user cannot publish the second user notebook');
select throws_ok($sql$
  select * from public.compare_and_swap_sync_manifest(
    'notebook-b',
    1,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-b","createdAt":"2026-09-10T00:07:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["b-snapshot"],"prunedSnapshotIds":[]}'::jsonb
  )
$sql$, '42501', 'notebook is not owned by the authenticated user', 'the first user cannot CAS the second user notebook');
select throws_ok($sql$select public.delete_pruned_sync_snapshot('notebook-b', 'b-snapshot')$sql$, '42501', 'notebook is not owned by the authenticated user', 'the first user cannot delete the second user notebook');

select is(
  (select status from public.create_sync_snapshot(
    'notebook-a',
    'prune-me',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"prune-me","notebookId":"notebook-a","deviceId":"device-a","parentSnapshotIds":["snapshot-a"],"createdAt":"2026-09-10T00:08:00.000Z","revision":2,"categories":[]}'::jsonb
  )),
  'created',
  'a snapshot can be marked for retention cleanup'
);
select is(
  (select status from public.create_sync_snapshot(
    'notebook-a',
    'head-me',
    '{"protocolVersion":1,"type":"snapshot","snapshotId":"head-me","notebookId":"notebook-a","deviceId":"device-a","parentSnapshotIds":["snapshot-a"],"createdAt":"2026-09-10T00:09:00.000Z","revision":2,"categories":[]}'::jsonb
  )),
  'created',
  'a current head is stored before deletion checks'
);
select is(
  (select applied from public.compare_and_swap_sync_manifest(
    'notebook-a',
    2,
    '{"protocolVersion":1,"type":"manifest","notebookId":"notebook-a","createdAt":"2026-09-10T00:10:00.000Z","createdByDeviceId":"device-a","headSnapshotIds":["head-me"],"prunedSnapshotIds":["prune-me"]}'::jsonb
  )),
  true,
  'retention state is published through the CAS'
);
select throws_ok($sql$select public.delete_pruned_sync_snapshot('notebook-a', 'head-me')$sql$, 'P0001', 'snapshot is not marked pruned or is still a head', 'a current head cannot be deleted');
select is(public.delete_pruned_sync_snapshot('notebook-a', 'prune-me'), true, 'a manifest-pruned non-head can be deleted');
select is(public.delete_pruned_sync_snapshot('notebook-a', 'prune-me'), true, 'deleting a missing pruned snapshot is idempotent');

set local role postgres;
select * from finish();
rollback;
