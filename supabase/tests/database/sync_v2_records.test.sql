begin;

select no_plan();

select ok(to_regclass('public.sync_v2_notebooks') is not null, 'v2 notebooks table exists');
select ok(to_regclass('public.sync_v2_categories') is not null, 'v2 categories table exists');
select ok(to_regclass('public.sync_v2_tasks') is not null, 'v2 tasks table exists');
select ok(to_regclass('public.sync_v2_changes') is not null, 'v2 changes ledger exists');
select ok(to_regclass('public.sync_v2_change_seq') is not null, 'v2 shared change sequence exists');
select ok(
  (select relrowsecurity from pg_class where oid = 'public.sync_v2_notebooks'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.sync_v2_categories'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.sync_v2_tasks'::regclass)
  and (select relrowsecurity from pg_class where oid = 'public.sync_v2_changes'::regclass),
  'RLS is enabled on every v2 table'
);
select ok(has_table_privilege('authenticated', 'public.sync_v2_notebooks', 'SELECT'), 'authenticated can read v2 notebooks');
select ok(has_table_privilege('authenticated', 'public.sync_v2_categories', 'SELECT'), 'authenticated can read v2 categories');
select ok(has_table_privilege('authenticated', 'public.sync_v2_tasks', 'SELECT'), 'authenticated can read v2 tasks');
select ok(has_table_privilege('authenticated', 'public.sync_v2_changes', 'SELECT'), 'authenticated can read v2 changes');
select ok(
  not has_table_privilege('authenticated', 'public.sync_v2_categories', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sync_v2_categories', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.sync_v2_categories', 'DELETE')
  and not has_table_privilege('authenticated', 'public.sync_v2_tasks', 'INSERT')
  and not has_table_privilege('authenticated', 'public.sync_v2_tasks', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.sync_v2_tasks', 'DELETE'),
  'authenticated cannot mutate record tables directly'
);
select ok(
  not has_table_privilege('anon', 'public.sync_v2_categories', 'SELECT')
  and not has_table_privilege('anon', 'public.sync_v2_tasks', 'SELECT'),
  'anonymous clients have no v2 table access'
);
select ok(not has_function_privilege('anon', 'public.initialize_sync_v2_notebook(text, jsonb, jsonb)', 'EXECUTE'), 'anon cannot initialize v2 notebooks');
select ok(not has_function_privilege('anon', 'public.mutate_sync_v2_category(text, text, text, bigint, jsonb)', 'EXECUTE'), 'anon cannot mutate v2 categories');
select ok(not has_function_privilege('anon', 'public.mutate_sync_v2_task(text, text, text, bigint, jsonb)', 'EXECUTE'), 'anon cannot mutate v2 tasks');
select ok(not has_function_privilege('anon', 'public.read_sync_v2_changes(text, bigint, integer)', 'EXECUTE'), 'anon cannot read the v2 change cursor');
select ok(
  exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_v2_categories')
  and exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sync_v2_tasks'),
  'both record tables are in the Realtime publication'
);

set local role postgres;
insert into auth.users (id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000011', 'authenticated', 'authenticated', 'sync-v2-a@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000012', 'authenticated', 'authenticated', 'sync-v2-b@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
on conflict (id) do nothing;

set local role anon;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000011","role":"anon"}', true);
select throws_ok($sql$
  select count(*) from public.sync_v2_notebooks
$sql$, '42501', NULL, 'anonymous table reads are denied');
select throws_ok($sql$
  select * from public.initialize_sync_v2_notebook('anon-notebook', '[]'::jsonb, '[]'::jsonb)
$sql$, '42501', NULL, 'anonymous initialization is denied');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000011","role":"authenticated"}', true);

select lives_ok($sql$
  select * from public.initialize_sync_v2_notebook(
    'notebook-v2-a',
    '[
      {"recordType":"category","id":"cat-a","name":"Work","sortKey":"U","updatedAt":"2026-09-10T00:00:00.000Z","version":0,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":0}
    ]'::jsonb,
    '[
      {"recordType":"task","id":"task-a","categoryId":"cat-a","title":"First task","scheduledDates":["2026-09-10"],"deadlineDate":"2026-09-11","sortKey":"U","updatedAt":"2026-09-10T00:00:00.000Z","version":0,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"categoryId":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"title":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"scheduledDates":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"deadlineDate":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":0}
    ]'::jsonb
  )
$sql$, 'initialization creates the notebook, records, and ledger atomically');
select is((select count(*) from public.sync_v2_categories where notebook_id = 'notebook-v2-a'), 1::bigint, 'initial category is stored');
select is((select count(*) from public.sync_v2_tasks where notebook_id = 'notebook-v2-a'), 1::bigint, 'initial task is stored');
select is((select count(*) from public.sync_v2_changes where notebook_id = 'notebook-v2-a'), 2::bigint, 'initial records each create one ledger entry');
select is((select version from public.sync_v2_categories where notebook_id = 'notebook-v2-a' and category_id = 'cat-a'), 1::bigint, 'initial category receives server version one');
select ok((select change_seq from public.sync_v2_categories where notebook_id = 'notebook-v2-a' and category_id = 'cat-a') > 0, 'initial category receives a server sequence');
select is((select payload ->> 'ownerId' from public.sync_v2_changes where notebook_id = 'notebook-v2-a' and record_id = 'cat-a'), '00000000-0000-0000-0000-000000000011', 'ledger payload carries authenticated ownership');
select is((select count(*) from public.read_sync_v2_changes('notebook-v2-a', 0, 100)), 2::bigint, 'ordered cursor read returns the initial changes');
select is((select count(*) from public.read_sync_v2_changes('notebook-v2-a', (select min(change_seq) from public.sync_v2_changes where notebook_id = 'notebook-v2-a'), 100)), 1::bigint, 'cursor read excludes the acknowledged sequence');

select throws_ok($sql$
  select * from public.mutate_sync_v2_category(
    'notebook-v2-a', 'cat-invalid', 'mutation-invalid', 0,
    '{"recordType":"category","id":"cat-invalid","name":"Bad","sortKey":"U","updatedAt":"2026-09-10T00:00:00.000Z","version":0,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"unexpected":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":0}'::jsonb
  )
$sql$, '22023', 'record field clocks are invalid', 'unsupported field clocks are rejected');

select is(
  (select outcome from public.mutate_sync_v2_category(
    'notebook-v2-a', 'cat-a', 'mutation-cat-1', 1,
    '{"recordType":"category","id":"cat-a","name":"Work updated","sortKey":"U","updatedAt":"2026-09-10T00:01:00.000Z","version":1,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:01:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":1}'::jsonb
  )),
  'accepted',
  'matching category version is accepted'
);
select is((select version from public.sync_v2_categories where notebook_id = 'notebook-v2-a' and category_id = 'cat-a'), 2::bigint, 'accepted category update increments version');
select is((select count(*) from public.sync_v2_changes where notebook_id = 'notebook-v2-a'), 3::bigint, 'accepted category update appends one ledger row');
select is(
  (select outcome from public.mutate_sync_v2_category(
    'notebook-v2-a', 'cat-a', 'mutation-cat-1', 1,
    '{"recordType":"category","id":"cat-a","name":"Work updated","sortKey":"U","updatedAt":"2026-09-10T00:01:00.000Z","version":1,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:01:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":1}'::jsonb
  )),
  'accepted',
  'replaying a mutation is idempotent'
);
select is((select count(*) from public.sync_v2_changes where notebook_id = 'notebook-v2-a'), 3::bigint, 'idempotent replay does not append a duplicate ledger row');
select is(
  (select outcome from public.mutate_sync_v2_category(
    'notebook-v2-a', 'cat-a', 'mutation-cat-stale', 1,
    '{"recordType":"category","id":"cat-a","name":"Stale","sortKey":"U","updatedAt":"2026-09-10T00:02:00.000Z","version":1,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:02:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":2}'::jsonb
  )),
  'stale',
  'stale category version is rejected without mutation'
);
select is((select (record ->> 'version')::bigint from public.mutate_sync_v2_category(
  'notebook-v2-a', 'cat-a', 'mutation-cat-stale-2', 1,
  '{"recordType":"category","id":"cat-a","name":"Stale","sortKey":"U","updatedAt":"2026-09-10T00:02:00.000Z","version":1,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:02:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":2}'::jsonb
)), 2::bigint, 'stale response returns the current canonical row');
select is((select count(*) from public.sync_v2_changes where notebook_id = 'notebook-v2-a'), 3::bigint, 'stale write does not append a ledger row');

select is((select outcome from public.mutate_sync_v2_task(
  'notebook-v2-a', 'task-a', 'mutation-task-1', 1,
  '{"recordType":"task","id":"task-a","categoryId":"cat-a","title":"Updated task","scheduledDates":["2026-09-10"],"deadlineDate":"2026-09-12","sortKey":"U","updatedAt":"2026-09-10T00:04:00.000Z","version":1,"deletedAt":null,"updatedByDeviceId":"device-a","fieldUpdatedAt":{"categoryId":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"title":{"at":"2026-09-10T00:04:00.000Z","deviceId":"device-a"},"scheduledDates":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"},"deadlineDate":{"at":"2026-09-10T00:04:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":2}'::jsonb
)), 'accepted', 'matching task version is accepted');
select is((select version from public.sync_v2_tasks where notebook_id = 'notebook-v2-a' and task_id = 'task-a'), 2::bigint, 'accepted task update increments version');

select is((select outcome from public.mutate_sync_v2_category(
  'notebook-v2-a', 'cat-a', 'mutation-cat-delete', 2,
  '{"recordType":"category","id":"cat-a","name":"Work updated","sortKey":"U","updatedAt":"2026-09-10T00:01:00.000Z","version":2,"deletedAt":"2026-09-10T00:05:00.000Z","updatedByDeviceId":"device-b","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:01:00.000Z","deviceId":"device-a"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-a"}},"changeSeq":3}'::jsonb
)), 'accepted', 'category tombstone is accepted');
select ok((select deleted_at is not null from public.sync_v2_categories where notebook_id = 'notebook-v2-a' and category_id = 'cat-a'), 'category tombstone is stored');
select ok((select deleted_at is not null from public.sync_v2_tasks where notebook_id = 'notebook-v2-a' and task_id = 'task-a'), 'category deletion cascades a task tombstone');
select ok((select count(*) from public.sync_v2_changes where notebook_id = 'notebook-v2-a') >= 6, 'category deletion and cascade append ledger entries atomically');
select is((select outcome from public.mutate_sync_v2_category(
  'notebook-v2-a', 'cat-a', 'mutation-cat-resurrect', 3,
  '{"recordType":"category","id":"cat-a","name":"Resurrected","sortKey":"U","updatedAt":"2026-09-10T00:06:00.000Z","version":3,"deletedAt":null,"updatedByDeviceId":"device-b","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:06:00.000Z","deviceId":"device-b"},"sortKey":{"at":"2026-09-10T00:06:00.000Z","deviceId":"device-b"}},"changeSeq":5}'::jsonb
)), 'stale', 'a tombstoned category cannot be resurrected by an exact-version edit');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000012","role":"authenticated"}', true);
select is((select count(*) from public.sync_v2_notebooks), 0::bigint, 'a different account cannot read the first account notebook');
select throws_ok($sql$
  select * from public.read_sync_v2_changes('notebook-v2-a', 0, 100)
$sql$, '42501', 'notebook is not owned by the authenticated user', 'a different account cannot read the first account cursor');
select throws_ok($sql$
  select * from public.initialize_sync_v2_notebook(
    'notebook-v2-b',
    '[{"recordType":"category","id":"cat-b","name":"B","sortKey":"U","updatedAt":"2026-09-10T00:00:00.000Z","version":0,"deletedAt":null,"updatedByDeviceId":"device-b","fieldUpdatedAt":{"name":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"}},"changeSeq":0}]'::jsonb,
    '[{"recordType":"task","id":"orphan","categoryId":"missing","title":"Orphan","scheduledDates":[],"deadlineDate":null,"sortKey":"U","updatedAt":"2026-09-10T00:00:00.000Z","version":0,"deletedAt":null,"updatedByDeviceId":"device-b","fieldUpdatedAt":{"categoryId":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"},"title":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"},"scheduledDates":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"},"deadlineDate":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"},"sortKey":{"at":"2026-09-10T00:00:00.000Z","deviceId":"device-b"}},"changeSeq":0}]'::jsonb
  )
$sql$, '23503', NULL, 'initialization rejects orphan tasks atomically');
select is((select count(*) from public.sync_v2_notebooks where notebook_id = 'notebook-v2-b'), 0::bigint, 'failed initialization leaves no notebook behind');

set local role postgres;
select * from finish();
rollback;
