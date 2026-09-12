-- Backlogger record-sync v2 schema.
--
-- The old snapshot tables remain untouched.  Clients can read these tables
-- through RLS and Realtime, but all mutations go through the security-definer
-- functions below.  The change ledger is append-only and is the only cursor
-- source for delta synchronization.

create sequence public.sync_v2_change_seq
  as bigint
  start with 1
  increment by 1
  no cycle;

create or replace function public.sync_v2_iso_timestamp(p_value timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char($1 at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

create or replace function public.sync_v2_valid_clock_map(p_value jsonb, p_fields text[])
returns boolean
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_field text;
  v_clock jsonb;
  v_at timestamptz;
begin
  if p_fields is null
    or cardinality(p_fields) = 0
    or jsonb_typeof(p_value) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_value)) <> cardinality(p_fields) then
    return false;
  end if;

  foreach v_field in array p_fields loop
    if not (p_value ? v_field) then
      return false;
    end if;
    v_clock := p_value -> v_field;
    if jsonb_typeof(v_clock) is distinct from 'object'
      or not (v_clock ?& array['at', 'deviceId']::text[])
      or v_clock - array['at', 'deviceId']::text[] <> '{}'::jsonb
      or btrim(coalesce(v_clock ->> 'deviceId', '')) = ''
      or btrim(coalesce(v_clock ->> 'at', '')) = '' then
      return false;
    end if;
    begin
      v_at := (v_clock ->> 'at')::timestamptz;
    exception when others then
      return false;
    end;
    if public.sync_v2_iso_timestamp(v_at) <> (v_clock ->> 'at') then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create or replace function public.sync_v2_valid_date_array(p_value jsonb)
returns boolean
language plpgsql
stable
strict
set search_path = ''
as $$
declare
  v_date text;
  v_previous text := null;
  v_parsed date;
begin
  if jsonb_typeof(p_value) is distinct from 'array' then
    return false;
  end if;
  for v_date in select jsonb_array_elements_text(p_value) loop
    if v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      return false;
    end if;
    begin
      v_parsed := v_date::date;
    exception when others then
      return false;
    end;
    if to_char(v_parsed, 'YYYY-MM-DD') <> v_date then
      return false;
    end if;
    if v_previous is not null and v_date <= v_previous then
      return false;
    end if;
    v_previous := v_date;
  end loop;
  return true;
end;
$$;

-- Validate the local-record payload accepted by initialization and OCC
-- mutation RPCs.  Provider identity is deliberately not accepted from the
-- client; notebook_id and owner_id are taken from the authenticated binding.
create or replace function public.sync_v2_validate_local_payload(
  p_payload jsonb,
  p_record_type text,
  p_record_id text,
  p_expected_version bigint
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_allowed text[];
  v_fields text[];
  v_field text;
  v_updated_at timestamptz;
  v_deleted_at timestamptz;
  v_version bigint;
  v_change_seq bigint;
  v_latest text := null;
  v_latest_device text := null;
  v_field_clock jsonb;
begin
  if p_record_type not in ('category', 'task')
    or p_record_id is null
    or btrim(p_record_id) = ''
    or p_expected_version is null
    or p_expected_version < 0
    or jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid record identity or payload' using errcode = '22023';
  end if;

  if p_record_type = 'category' then
    v_allowed := array['recordType', 'id', 'name', 'sortKey', 'updatedAt', 'version',
      'deletedAt', 'updatedByDeviceId', 'fieldUpdatedAt', 'changeSeq'];
    v_fields := array['name', 'sortKey'];
  else
    v_allowed := array['recordType', 'id', 'categoryId', 'title', 'scheduledDates',
      'deadlineDate', 'sortKey', 'updatedAt', 'version', 'deletedAt',
      'updatedByDeviceId', 'fieldUpdatedAt', 'changeSeq'];
    v_fields := array['categoryId', 'title', 'scheduledDates', 'deadlineDate', 'sortKey'];
  end if;

  if p_payload - v_allowed <> '{}'::jsonb
    or not (p_payload ?& v_allowed)
    or p_payload ->> 'recordType' is distinct from p_record_type
    or p_payload ->> 'id' is distinct from p_record_id then
    raise exception 'record payload has unsupported, missing, or mismatched fields' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'version') is distinct from 'number'
    or jsonb_typeof(p_payload -> 'changeSeq') is distinct from 'number' then
    raise exception 'record version and change sequence must be numbers' using errcode = '22023';
  end if;
  begin
    v_version := (p_payload ->> 'version')::bigint;
    v_change_seq := (p_payload ->> 'changeSeq')::bigint;
  exception when others then
    raise exception 'record version and change sequence must be integers' using errcode = '22023';
  end;
  if v_version < 0 or v_change_seq < 0 or v_version <> p_expected_version then
    raise exception 'record version does not match expected_version' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'updatedAt') is distinct from 'string'
    or btrim(coalesce(p_payload ->> 'updatedAt', '')) = '' then
    raise exception 'updatedAt must be a canonical ISO timestamp' using errcode = '22023';
  end if;
  begin
    v_updated_at := (p_payload ->> 'updatedAt')::timestamptz;
  exception when others then
    raise exception 'updatedAt must be a canonical ISO timestamp' using errcode = '22023';
  end;
  if public.sync_v2_iso_timestamp(v_updated_at) <> (p_payload ->> 'updatedAt') then
    raise exception 'updatedAt must be a canonical ISO timestamp' using errcode = '22023';
  end if;

  if jsonb_typeof(p_payload -> 'deletedAt') not in ('null', 'string') then
    raise exception 'deletedAt must be null or a canonical ISO timestamp' using errcode = '22023';
  end if;
  if p_payload ->> 'deletedAt' is not null then
    begin
      v_deleted_at := (p_payload ->> 'deletedAt')::timestamptz;
    exception when others then
      raise exception 'deletedAt must be null or a canonical ISO timestamp' using errcode = '22023';
    end;
    if public.sync_v2_iso_timestamp(v_deleted_at) <> (p_payload ->> 'deletedAt') then
      raise exception 'deletedAt must be null or a canonical ISO timestamp' using errcode = '22023';
    end if;
  end if;

  if btrim(coalesce(p_payload ->> 'updatedByDeviceId', '')) = ''
    or not public.sync_v2_valid_clock_map(p_payload -> 'fieldUpdatedAt', v_fields) then
    raise exception 'record field clocks are invalid' using errcode = '22023';
  end if;
  foreach v_field in array v_fields loop
    v_field_clock := p_payload -> 'fieldUpdatedAt' -> v_field;
    if v_latest is null or v_field_clock ->> 'at' > v_latest then
      v_latest := v_field_clock ->> 'at';
      v_latest_device := v_field_clock ->> 'deviceId';
    end if;
  end loop;
  if v_latest is distinct from p_payload ->> 'updatedAt' then
    raise exception 'updatedAt must match the latest business-field clock' using errcode = '22023';
  end if;
  if p_payload ->> 'deletedAt' is null
    and v_latest_device is distinct from p_payload ->> 'updatedByDeviceId' then
    raise exception 'updatedByDeviceId must match the latest business-field clock' using errcode = '22023';
  end if;

  if p_record_type = 'category' then
    if btrim(coalesce(p_payload ->> 'name', '')) = ''
      or btrim(coalesce(p_payload ->> 'sortKey', '')) = '' then
      raise exception 'category name and sort key must be nonblank' using errcode = '22023';
    end if;
  else
    if btrim(coalesce(p_payload ->> 'categoryId', '')) = ''
      or btrim(coalesce(p_payload ->> 'title', '')) = ''
      or btrim(coalesce(p_payload ->> 'sortKey', '')) = ''
      or not public.sync_v2_valid_date_array(p_payload -> 'scheduledDates') then
      raise exception 'task fields are invalid' using errcode = '22023';
    end if;
    if jsonb_typeof(p_payload -> 'deadlineDate') not in ('null', 'string') then
      raise exception 'deadlineDate must be null or a calendar date' using errcode = '22023';
    end if;
    if p_payload ->> 'deadlineDate' is not null then
      begin
        if to_char((p_payload ->> 'deadlineDate')::date, 'YYYY-MM-DD') <> p_payload ->> 'deadlineDate' then
          raise exception 'noncanonical deadline date';
        end if;
      exception when others then
        raise exception 'deadlineDate must be null or a calendar date' using errcode = '22023';
      end;
    end if;
  end if;
end;
$$;

create table public.sync_v2_notebooks (
  notebook_id text primary key not null,
  owner_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sync_v2_notebooks_id_not_blank check (btrim(notebook_id) <> ''),
  constraint sync_v2_notebooks_id_length check (char_length(notebook_id) <= 200),
  constraint sync_v2_notebooks_one_per_owner unique (owner_id),
  constraint sync_v2_notebooks_owner_binding unique (notebook_id, owner_id)
);

create table public.sync_v2_categories (
  notebook_id text not null,
  owner_id uuid not null,
  category_id text not null,
  name text not null,
  sort_key text not null,
  updated_at timestamptz not null,
  version bigint not null,
  deleted_at timestamptz,
  updated_by_device_id text not null,
  field_updated_at jsonb not null,
  change_seq bigint not null,
  primary key (notebook_id, category_id),
  constraint sync_v2_categories_owner_record_key unique (notebook_id, owner_id, category_id),
  constraint sync_v2_categories_notebook_owner_fk
    foreign key (notebook_id, owner_id)
    references public.sync_v2_notebooks (notebook_id, owner_id)
    on update cascade on delete cascade,
  constraint sync_v2_categories_id_not_blank check (btrim(category_id) <> ''),
  constraint sync_v2_categories_id_length check (char_length(category_id) <= 200),
  constraint sync_v2_categories_name_not_blank check (btrim(name) <> ''),
  constraint sync_v2_categories_sort_key_not_blank check (btrim(sort_key) <> ''),
  constraint sync_v2_categories_version_nonnegative check (version >= 0),
  constraint sync_v2_categories_change_seq_nonnegative check (change_seq >= 0),
  constraint sync_v2_categories_device_not_blank check (btrim(updated_by_device_id) <> ''),
  constraint sync_v2_categories_clocks_allow_list check (
    public.sync_v2_valid_clock_map(field_updated_at, array['name', 'sortKey']::text[])
  )
);

create table public.sync_v2_tasks (
  notebook_id text not null,
  owner_id uuid not null,
  task_id text not null,
  category_id text not null,
  title text not null,
  scheduled_dates jsonb not null,
  deadline_date date,
  sort_key text not null,
  updated_at timestamptz not null,
  version bigint not null,
  deleted_at timestamptz,
  updated_by_device_id text not null,
  field_updated_at jsonb not null,
  change_seq bigint not null,
  primary key (notebook_id, task_id),
  constraint sync_v2_tasks_notebook_owner_fk
    foreign key (notebook_id, owner_id)
    references public.sync_v2_notebooks (notebook_id, owner_id)
    on update cascade on delete cascade,
  constraint sync_v2_tasks_category_fk
    foreign key (notebook_id, owner_id, category_id)
    references public.sync_v2_categories (notebook_id, owner_id, category_id)
    on update cascade on delete restrict,
  constraint sync_v2_tasks_id_not_blank check (btrim(task_id) <> ''),
  constraint sync_v2_tasks_id_length check (char_length(task_id) <= 200),
  constraint sync_v2_tasks_category_not_blank check (btrim(category_id) <> ''),
  constraint sync_v2_tasks_title_not_blank check (btrim(title) <> ''),
  constraint sync_v2_tasks_sort_key_not_blank check (btrim(sort_key) <> ''),
  constraint sync_v2_tasks_dates_valid check (public.sync_v2_valid_date_array(scheduled_dates)),
  constraint sync_v2_tasks_version_nonnegative check (version >= 0),
  constraint sync_v2_tasks_change_seq_nonnegative check (change_seq >= 0),
  constraint sync_v2_tasks_device_not_blank check (btrim(updated_by_device_id) <> ''),
  constraint sync_v2_tasks_clocks_allow_list check (
    public.sync_v2_valid_clock_map(field_updated_at,
      array['categoryId', 'title', 'scheduledDates', 'deadlineDate', 'sortKey']::text[])
  )
);

create index sync_v2_categories_order_idx
  on public.sync_v2_categories (notebook_id, deleted_at, sort_key, category_id);
create index sync_v2_tasks_category_order_idx
  on public.sync_v2_tasks (notebook_id, category_id, deleted_at, sort_key, task_id);

create table public.sync_v2_changes (
  change_seq bigint primary key not null default nextval('public.sync_v2_change_seq'),
  notebook_id text not null,
  owner_id uuid not null,
  record_type text not null,
  record_id text not null,
  mutation_id text,
  expected_version bigint not null,
  request_payload jsonb,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint sync_v2_changes_notebook_owner_fk
    foreign key (notebook_id, owner_id)
    references public.sync_v2_notebooks (notebook_id, owner_id)
    on update cascade on delete cascade,
  constraint sync_v2_changes_record_type_valid check (record_type in ('category', 'task')),
  constraint sync_v2_changes_record_id_not_blank check (btrim(record_id) <> ''),
  constraint sync_v2_changes_mutation_id_not_blank check (mutation_id is null or btrim(mutation_id) <> ''),
  constraint sync_v2_changes_expected_version_nonnegative check (expected_version >= 0),
  constraint sync_v2_changes_request_payload_object check (
    request_payload is null or jsonb_typeof(request_payload) = 'object'
  ),
  constraint sync_v2_changes_payload_valid check (
    jsonb_typeof(payload) = 'object'
    and payload ->> 'recordType' = record_type
    and payload ->> 'id' = record_id
    and payload ->> 'notebookId' = notebook_id
    and payload ->> 'ownerId' = owner_id::text
    and jsonb_typeof(payload -> 'version') = 'number'
    and (payload ->> 'version')::bigint > 0
    and jsonb_typeof(payload -> 'changeSeq') = 'number'
    and (payload ->> 'changeSeq')::bigint = change_seq
  ),
  constraint sync_v2_changes_mutation_id_unique unique (notebook_id, mutation_id)
);

create index sync_v2_changes_notebook_cursor_idx
  on public.sync_v2_changes (notebook_id, change_seq);

create or replace function public.sync_v2_category_payload(p_row public.sync_v2_categories)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'recordType', 'category',
    'id', ($1).category_id,
    'notebookId', ($1).notebook_id,
    'ownerId', ($1).owner_id,
    'name', ($1).name,
    'sortKey', ($1).sort_key,
    'updatedAt', public.sync_v2_iso_timestamp(($1).updated_at),
    'version', ($1).version,
    'deletedAt', case when ($1).deleted_at is null then null else public.sync_v2_iso_timestamp(($1).deleted_at) end,
    'updatedByDeviceId', ($1).updated_by_device_id,
    'fieldUpdatedAt', ($1).field_updated_at,
    'changeSeq', ($1).change_seq
  );
$$;

create or replace function public.sync_v2_task_payload(p_row public.sync_v2_tasks)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'recordType', 'task',
    'id', ($1).task_id,
    'notebookId', ($1).notebook_id,
    'ownerId', ($1).owner_id,
    'categoryId', ($1).category_id,
    'title', ($1).title,
    'scheduledDates', ($1).scheduled_dates,
    'deadlineDate', case when ($1).deadline_date is null then null else to_char(($1).deadline_date, 'YYYY-MM-DD') end,
    'sortKey', ($1).sort_key,
    'updatedAt', public.sync_v2_iso_timestamp(($1).updated_at),
    'version', ($1).version,
    'deletedAt', case when ($1).deleted_at is null then null else public.sync_v2_iso_timestamp(($1).deleted_at) end,
    'updatedByDeviceId', ($1).updated_by_device_id,
    'fieldUpdatedAt', ($1).field_updated_at,
    'changeSeq', ($1).change_seq
  );
$$;

-- Insert one immutable ledger row for every child tombstoned by a category
-- deletion.  The parent RPC calls this after its own row is accepted.
create or replace function public.sync_v2_cascade_category_tasks(
  p_category public.sync_v2_categories,
  p_parent_mutation_id text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.sync_v2_tasks;
  v_expected_version bigint;
  v_mutation_id text;
  v_payload jsonb;
begin
  if p_category.deleted_at is null then
    return;
  end if;
  for v_task in
    select t.*
    from public.sync_v2_tasks as t
    where t.notebook_id = p_category.notebook_id
      and t.owner_id = p_category.owner_id
      and t.category_id = p_category.category_id
      and t.deleted_at is null
    order by t.task_id
    for update
  loop
    v_expected_version := v_task.version;
    v_mutation_id := p_parent_mutation_id || ':task:' || v_task.task_id;
    update public.sync_v2_tasks as t
    set deleted_at = p_category.deleted_at,
        updated_by_device_id = p_category.updated_by_device_id,
        version = v_task.version + 1,
        change_seq = nextval('public.sync_v2_change_seq')
    where t.notebook_id = v_task.notebook_id
      and t.task_id = v_task.task_id
    returning * into v_task;
    v_payload := public.sync_v2_task_payload(v_task);
    insert into public.sync_v2_changes (
      change_seq, notebook_id, owner_id, record_type, record_id, mutation_id,
      expected_version, request_payload, payload
    ) values (
      v_task.change_seq, v_task.notebook_id, v_task.owner_id, 'task', v_task.task_id,
      v_mutation_id, v_expected_version, null, v_payload
    );
  end loop;
end;
$$;

create or replace function public.initialize_sync_v2_notebook(
  p_notebook_id text,
  p_categories jsonb default '[]'::jsonb,
  p_tasks jsonb default '[]'::jsonb
)
returns table (
  notebook_id text,
  owner_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  category_count integer,
  task_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := auth.uid();
  v_category jsonb;
  v_task jsonb;
  v_category_row public.sync_v2_categories;
  v_task_row public.sync_v2_tasks;
  v_notebook public.sync_v2_notebooks;
  v_category_id text;
  v_task_id text;
  v_categories integer := 0;
  v_tasks integer := 0;
begin
  if v_owner_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_notebook_id is null or btrim(p_notebook_id) = '' then
    raise exception 'notebook id must be nonblank' using errcode = '22023';
  end if;
  if jsonb_typeof(p_categories) is distinct from 'array'
    or jsonb_typeof(p_tasks) is distinct from 'array' then
    raise exception 'initial categories and tasks must be arrays' using errcode = '22023';
  end if;
  if exists (select 1 from public.sync_v2_notebooks as n where n.owner_id = v_owner_id) then
    raise exception 'the authenticated account already has a v2 notebook' using errcode = '23505';
  end if;
  if exists (select 1 from public.sync_v2_notebooks as n where n.notebook_id = p_notebook_id) then
    raise exception 'the notebook id already exists' using errcode = '23505';
  end if;

  -- Validate every input before creating any rows.  The surrounding function
  -- transaction also rolls back all rows if a later relationship is invalid.
  for v_category in select value from jsonb_array_elements(p_categories) loop
    v_category_id := coalesce(v_category ->> 'id', '');
    perform public.sync_v2_validate_local_payload(
      v_category, 'category', v_category_id, (v_category ->> 'version')::bigint
    );
  end loop;
  for v_task in select value from jsonb_array_elements(p_tasks) loop
    v_task_id := coalesce(v_task ->> 'id', '');
    perform public.sync_v2_validate_local_payload(
      v_task, 'task', v_task_id, (v_task ->> 'version')::bigint
    );
  end loop;

  insert into public.sync_v2_notebooks (notebook_id, owner_id)
  values (p_notebook_id, v_owner_id)
  returning * into v_notebook;

  for v_category in select value from jsonb_array_elements(p_categories) loop
    insert into public.sync_v2_categories (
      notebook_id, owner_id, category_id, name, sort_key, updated_at, version,
      deleted_at, updated_by_device_id, field_updated_at, change_seq
    ) values (
      p_notebook_id, v_owner_id, v_category ->> 'id', v_category ->> 'name',
      v_category ->> 'sortKey', (v_category ->> 'updatedAt')::timestamptz, 1,
      case when v_category ->> 'deletedAt' is null then null else (v_category ->> 'deletedAt')::timestamptz end,
      v_category ->> 'updatedByDeviceId', v_category -> 'fieldUpdatedAt',
      nextval('public.sync_v2_change_seq')
    ) returning * into v_category_row;
    insert into public.sync_v2_changes (
      change_seq, notebook_id, owner_id, record_type, record_id, expected_version,
      request_payload, payload
    ) values (
      v_category_row.change_seq, p_notebook_id, v_owner_id, 'category', v_category_row.category_id, 0,
      null, public.sync_v2_category_payload(v_category_row)
    );
    v_categories := v_categories + 1;
  end loop;

  for v_task in select value from jsonb_array_elements(p_tasks) loop
    if v_task ->> 'deletedAt' is null and exists (
      select 1
      from public.sync_v2_categories as c
      where c.notebook_id = p_notebook_id
        and c.owner_id = v_owner_id
        and c.category_id = v_task ->> 'categoryId'
        and c.deleted_at is not null
    ) then
      raise exception 'an active task cannot belong to a deleted category' using errcode = '22023';
    end if;
    insert into public.sync_v2_tasks (
      notebook_id, owner_id, task_id, category_id, title, scheduled_dates,
      deadline_date, sort_key, updated_at, version, deleted_at,
      updated_by_device_id, field_updated_at, change_seq
    ) values (
      p_notebook_id, v_owner_id, v_task ->> 'id', v_task ->> 'categoryId',
      v_task ->> 'title', v_task -> 'scheduledDates',
      case when v_task ->> 'deadlineDate' is null then null else (v_task ->> 'deadlineDate')::date end,
      v_task ->> 'sortKey', (v_task ->> 'updatedAt')::timestamptz, 1,
      case when v_task ->> 'deletedAt' is null then null else (v_task ->> 'deletedAt')::timestamptz end,
      v_task ->> 'updatedByDeviceId', v_task -> 'fieldUpdatedAt',
      nextval('public.sync_v2_change_seq')
    ) returning * into v_task_row;
    insert into public.sync_v2_changes (
      change_seq, notebook_id, owner_id, record_type, record_id, expected_version,
      request_payload, payload
    ) values (
      v_task_row.change_seq, p_notebook_id, v_owner_id, 'task', v_task_row.task_id, 0,
      null, public.sync_v2_task_payload(v_task_row)
    );
    v_tasks := v_tasks + 1;
  end loop;

  update public.sync_v2_notebooks as n
  set updated_at = now()
  where n.notebook_id = p_notebook_id
  returning * into v_notebook;

  return query select v_notebook.notebook_id, v_notebook.owner_id, v_notebook.created_at,
    v_notebook.updated_at, v_categories, v_tasks;
end;
$$;

create or replace function public.read_sync_v2_changes(
  p_notebook_id text,
  p_after_seq bigint default 0,
  p_limit integer default 100
)
returns table (
  change_seq bigint,
  record_type text,
  record_id text,
  notebook_id text,
  owner_id uuid,
  payload jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := auth.uid();
begin
  if v_owner_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_notebook_id is null or btrim(p_notebook_id) = ''
    or p_after_seq is null or p_after_seq < 0
    or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid change cursor or page size' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.sync_v2_notebooks as n
    where n.notebook_id = p_notebook_id and n.owner_id = v_owner_id
  ) then
    raise exception 'notebook is not owned by the authenticated user' using errcode = '42501';
  end if;
  return query
    select c.change_seq, c.record_type, c.record_id, c.notebook_id, c.owner_id, c.payload
    from public.sync_v2_changes as c
    where c.notebook_id = p_notebook_id
      and c.owner_id = v_owner_id
      and c.change_seq > p_after_seq
    order by c.change_seq
    limit p_limit;
end;
$$;

create or replace function public.mutate_sync_v2_category(
  p_notebook_id text,
  p_category_id text,
  p_mutation_id text,
  p_expected_version bigint,
  p_payload jsonb
)
returns table (outcome text, record jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := auth.uid();
  v_current public.sync_v2_categories;
  v_replayed public.sync_v2_changes;
  v_payload jsonb;
begin
  if v_owner_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_mutation_id is null or btrim(p_mutation_id) = '' then
    raise exception 'mutation id must be nonblank' using errcode = '22023';
  end if;
  perform public.sync_v2_validate_local_payload(p_payload, 'category', p_category_id, p_expected_version);
  perform 1
  from public.sync_v2_notebooks as n
  where n.notebook_id = p_notebook_id
    and n.owner_id = v_owner_id
  for update;
  if not found then
    raise exception 'notebook is not owned by the authenticated user' using errcode = '42501';
  end if;

  select * into v_replayed
  from public.sync_v2_changes as ch
  where ch.notebook_id = p_notebook_id and ch.owner_id = v_owner_id and ch.mutation_id = p_mutation_id;
  if found then
    if v_replayed.record_type <> 'category'
      or v_replayed.record_id <> p_category_id
      or v_replayed.expected_version <> p_expected_version
      or v_replayed.request_payload is distinct from p_payload then
      raise exception 'mutation id was already used for different content' using errcode = '23505';
    end if;
    return query select 'accepted'::text, v_replayed.payload;
    return;
  end if;

  select * into v_current
  from public.sync_v2_categories as c
  where c.notebook_id = p_notebook_id and c.owner_id = v_owner_id and c.category_id = p_category_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      return query select 'stale'::text, null::jsonb;
      return;
    end if;
    insert into public.sync_v2_categories (
      notebook_id, owner_id, category_id, name, sort_key, updated_at, version,
      deleted_at, updated_by_device_id, field_updated_at, change_seq
    ) values (
      p_notebook_id, v_owner_id, p_category_id, p_payload ->> 'name', p_payload ->> 'sortKey',
      (p_payload ->> 'updatedAt')::timestamptz, 1,
      case when p_payload ->> 'deletedAt' is null then null else (p_payload ->> 'deletedAt')::timestamptz end,
      p_payload ->> 'updatedByDeviceId', p_payload -> 'fieldUpdatedAt',
      nextval('public.sync_v2_change_seq')
    ) returning * into v_current;
  else
    if p_expected_version <> v_current.version
      or (v_current.deleted_at is not null and p_payload ->> 'deletedAt' is null) then
      v_payload := public.sync_v2_category_payload(v_current);
      return query select 'stale'::text, v_payload;
      return;
    end if;
    update public.sync_v2_categories as c
    set name = p_payload ->> 'name',
        sort_key = p_payload ->> 'sortKey',
        updated_at = (p_payload ->> 'updatedAt')::timestamptz,
        version = v_current.version + 1,
        deleted_at = case when p_payload ->> 'deletedAt' is null then null else (p_payload ->> 'deletedAt')::timestamptz end,
        updated_by_device_id = p_payload ->> 'updatedByDeviceId',
        field_updated_at = p_payload -> 'fieldUpdatedAt',
        change_seq = nextval('public.sync_v2_change_seq')
    where c.notebook_id = p_notebook_id
      and c.owner_id = v_owner_id
      and c.category_id = p_category_id
    returning * into v_current;
  end if;

  v_payload := public.sync_v2_category_payload(v_current);
  insert into public.sync_v2_changes (
    change_seq, notebook_id, owner_id, record_type, record_id, mutation_id,
    expected_version, request_payload, payload
  ) values (
    v_current.change_seq, p_notebook_id, v_owner_id, 'category', p_category_id, p_mutation_id,
    p_expected_version, p_payload, v_payload
  );
  update public.sync_v2_notebooks as n set updated_at = now()
  where n.notebook_id = p_notebook_id
    and n.owner_id = v_owner_id;

  if v_current.deleted_at is not null then
    perform public.sync_v2_cascade_category_tasks(v_current, p_mutation_id);
  end if;
  return query select 'accepted'::text, v_payload;
end;
$$;

create or replace function public.mutate_sync_v2_task(
  p_notebook_id text,
  p_task_id text,
  p_mutation_id text,
  p_expected_version bigint,
  p_payload jsonb
)
returns table (outcome text, record jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := auth.uid();
  v_current public.sync_v2_tasks;
  v_replayed public.sync_v2_changes;
  v_payload jsonb;
begin
  if v_owner_id is null then
    raise exception 'authenticated user required' using errcode = '42501';
  end if;
  if p_mutation_id is null or btrim(p_mutation_id) = '' then
    raise exception 'mutation id must be nonblank' using errcode = '22023';
  end if;
  perform public.sync_v2_validate_local_payload(p_payload, 'task', p_task_id, p_expected_version);
  perform 1
  from public.sync_v2_notebooks as n
  where n.notebook_id = p_notebook_id
    and n.owner_id = v_owner_id
  for update;
  if not found then
    raise exception 'notebook is not owned by the authenticated user' using errcode = '42501';
  end if;
  select * into v_replayed
  from public.sync_v2_changes as ch
  where ch.notebook_id = p_notebook_id and ch.owner_id = v_owner_id and ch.mutation_id = p_mutation_id;
  if found then
    if v_replayed.record_type <> 'task'
      or v_replayed.record_id <> p_task_id
      or v_replayed.expected_version <> p_expected_version
      or v_replayed.request_payload is distinct from p_payload then
      raise exception 'mutation id was already used for different content' using errcode = '23505';
    end if;
    return query select 'accepted'::text, v_replayed.payload;
    return;
  end if;

  if p_payload ->> 'deletedAt' is null and not exists (
    select 1
    from public.sync_v2_categories as c
    where c.notebook_id = p_notebook_id
      and c.owner_id = v_owner_id
      and c.category_id = p_payload ->> 'categoryId'
      and c.deleted_at is null
  ) then
    raise exception 'an active task must belong to an active category' using errcode = '22023';
  end if;

  select * into v_current
  from public.sync_v2_tasks as t
  where t.notebook_id = p_notebook_id and t.owner_id = v_owner_id and t.task_id = p_task_id
  for update;

  if not found then
    if p_expected_version <> 0 then
      return query select 'stale'::text, null::jsonb;
      return;
    end if;
    insert into public.sync_v2_tasks (
      notebook_id, owner_id, task_id, category_id, title, scheduled_dates,
      deadline_date, sort_key, updated_at, version, deleted_at,
      updated_by_device_id, field_updated_at, change_seq
    ) values (
      p_notebook_id, v_owner_id, p_task_id, p_payload ->> 'categoryId', p_payload ->> 'title',
      p_payload -> 'scheduledDates',
      case when p_payload ->> 'deadlineDate' is null then null else (p_payload ->> 'deadlineDate')::date end,
      p_payload ->> 'sortKey', (p_payload ->> 'updatedAt')::timestamptz, 1,
      case when p_payload ->> 'deletedAt' is null then null else (p_payload ->> 'deletedAt')::timestamptz end,
      p_payload ->> 'updatedByDeviceId', p_payload -> 'fieldUpdatedAt',
      nextval('public.sync_v2_change_seq')
    ) returning * into v_current;
  else
    if p_expected_version <> v_current.version
      or (v_current.deleted_at is not null and p_payload ->> 'deletedAt' is null) then
      v_payload := public.sync_v2_task_payload(v_current);
      return query select 'stale'::text, v_payload;
      return;
    end if;
    update public.sync_v2_tasks as t
    set category_id = p_payload ->> 'categoryId',
        title = p_payload ->> 'title',
        scheduled_dates = p_payload -> 'scheduledDates',
        deadline_date = case when p_payload ->> 'deadlineDate' is null then null else (p_payload ->> 'deadlineDate')::date end,
        sort_key = p_payload ->> 'sortKey',
        updated_at = (p_payload ->> 'updatedAt')::timestamptz,
        version = v_current.version + 1,
        deleted_at = case when p_payload ->> 'deletedAt' is null then null else (p_payload ->> 'deletedAt')::timestamptz end,
        updated_by_device_id = p_payload ->> 'updatedByDeviceId',
        field_updated_at = p_payload -> 'fieldUpdatedAt',
        change_seq = nextval('public.sync_v2_change_seq')
    where t.notebook_id = p_notebook_id
      and t.owner_id = v_owner_id
      and t.task_id = p_task_id
    returning * into v_current;
  end if;

  v_payload := public.sync_v2_task_payload(v_current);
  insert into public.sync_v2_changes (
    change_seq, notebook_id, owner_id, record_type, record_id, mutation_id,
    expected_version, request_payload, payload
  ) values (
    v_current.change_seq, p_notebook_id, v_owner_id, 'task', p_task_id, p_mutation_id,
    p_expected_version, p_payload, v_payload
  );
  update public.sync_v2_notebooks as n set updated_at = now()
  where n.notebook_id = p_notebook_id
    and n.owner_id = v_owner_id;
  return query select 'accepted'::text, v_payload;
end;
$$;

-- Realtime needs the complete row for updates/deletes, while RLS remains the
-- visibility boundary for authenticated subscribers.
alter table public.sync_v2_categories replica identity full;
alter table public.sync_v2_tasks replica identity full;
alter publication supabase_realtime add table public.sync_v2_categories, public.sync_v2_tasks;

alter table public.sync_v2_notebooks enable row level security;
alter table public.sync_v2_categories enable row level security;
alter table public.sync_v2_tasks enable row level security;
alter table public.sync_v2_changes enable row level security;

create policy sync_v2_notebooks_select_own
  on public.sync_v2_notebooks for select to authenticated
  using (owner_id = (select auth.uid()));
create policy sync_v2_categories_select_own
  on public.sync_v2_categories for select to authenticated
  using (owner_id = (select auth.uid()));
create policy sync_v2_tasks_select_own
  on public.sync_v2_tasks for select to authenticated
  using (owner_id = (select auth.uid()));
create policy sync_v2_changes_select_own
  on public.sync_v2_changes for select to authenticated
  using (owner_id = (select auth.uid()));

-- The ledger is append-only even for a role that can otherwise bypass RLS.
create or replace function public.sync_v2_reject_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'sync_v2_changes is append-only';
end;
$$;

create trigger sync_v2_changes_append_only
  before update or delete on public.sync_v2_changes
  for each row execute function public.sync_v2_reject_ledger_mutation();

revoke all on sequence public.sync_v2_change_seq from public, anon, authenticated;
revoke all on table public.sync_v2_notebooks, public.sync_v2_categories,
  public.sync_v2_tasks, public.sync_v2_changes from public, anon, authenticated;
grant select on table public.sync_v2_notebooks, public.sync_v2_categories,
  public.sync_v2_tasks, public.sync_v2_changes to authenticated;

revoke all on function public.sync_v2_iso_timestamp(timestamptz) from public, anon, authenticated;
revoke all on function public.sync_v2_valid_clock_map(jsonb, text[]) from public, anon, authenticated;
revoke all on function public.sync_v2_valid_date_array(jsonb) from public, anon, authenticated;
revoke all on function public.sync_v2_validate_local_payload(jsonb, text, text, bigint) from public, anon, authenticated;
revoke all on function public.sync_v2_category_payload(public.sync_v2_categories) from public, anon, authenticated;
revoke all on function public.sync_v2_task_payload(public.sync_v2_tasks) from public, anon, authenticated;
revoke all on function public.sync_v2_cascade_category_tasks(public.sync_v2_categories, text) from public, anon, authenticated;
revoke all on function public.sync_v2_reject_ledger_mutation() from public, anon, authenticated;

revoke all on function public.initialize_sync_v2_notebook(text, jsonb, jsonb) from public, anon;
revoke all on function public.read_sync_v2_changes(text, bigint, integer) from public, anon;
revoke all on function public.mutate_sync_v2_category(text, text, text, bigint, jsonb) from public, anon;
revoke all on function public.mutate_sync_v2_task(text, text, text, bigint, jsonb) from public, anon;
grant execute on function public.initialize_sync_v2_notebook(text, jsonb, jsonb) to authenticated;
grant execute on function public.read_sync_v2_changes(text, bigint, integer) to authenticated;
grant execute on function public.mutate_sync_v2_category(text, text, text, bigint, jsonb) to authenticated;
grant execute on function public.mutate_sync_v2_task(text, text, text, bigint, jsonb) to authenticated;
