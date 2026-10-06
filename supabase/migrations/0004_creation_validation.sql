-- 0004：创建时拒绝非法历史事实，不改已部署的 0001/0002/0003。
-- 缺字段或 JSON null 保留旧协议默认；提供了但非法时不得悄悄替换成 now。
create or replace function public.validate_record_creation_payload(p_payload jsonb)
returns void
language plpgsql
stable
as $$
declare
  v text;
begin
  if p_payload ? 'createdAtUtc' and jsonb_typeof(p_payload -> 'createdAtUtc') <> 'null' then
    v := p_payload ->> 'createdAtUtc';
    if jsonb_typeof(p_payload -> 'createdAtUtc') <> 'string'
       or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+]00:00)$'
       then
      raise exception using errcode = '22023', message = 'invalid_createdAtUtc';
    end if;
    if substring(v from 1 for 4)::int = 0
       or substring(v from 12 for 2)::int > 23
       or substring(v from 15 for 2)::int > 59
       or substring(v from 18 for 2)::int > 59 then
      raise exception using errcode = '22023', message = 'invalid_createdAtUtc';
    end if;
    begin
      perform v::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'invalid_createdAtUtc';
    end;
  end if;

  if p_payload ? 'createdLocalDate' and jsonb_typeof(p_payload -> 'createdLocalDate') <> 'null' then
    v := p_payload ->> 'createdLocalDate';
    if jsonb_typeof(p_payload -> 'createdLocalDate') <> 'string'
       or v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       then
      raise exception using errcode = '22023', message = 'invalid_createdLocalDate';
    end if;
    if substring(v from 1 for 4)::int = 0 then
      raise exception using errcode = '22023', message = 'invalid_createdLocalDate';
    end if;
    begin
      perform v::date;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using errcode = '22023', message = 'invalid_createdLocalDate';
    end;
  end if;

  if p_payload ? 'createdTimezone' and jsonb_typeof(p_payload -> 'createdTimezone') <> 'null' then
    v := p_payload ->> 'createdTimezone';
    if jsonb_typeof(p_payload -> 'createdTimezone') <> 'string'
       or not (lower(v) in ('utc', 'gmt') or v ~ '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)+$')
       or lower(v) ~ '^(posix|right)/'
       or not exists (select 1 from pg_timezone_names where lower(name) = lower(v)) then
      raise exception using errcode = '22023', message = 'invalid_createdTimezone';
    end if;
  end if;
end;
$$;

-- RPC 保留 0003 的行锁、权限、幂等与完整字段；只在真正 INSERT 前验证创建事实。
create or replace function public.apply_record_mutation(
  p_mutation_id      uuid,
  p_record_id        uuid,
  p_operation        text,
  p_expected_version bigint,
  p_payload          jsonb
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_uid          uuid := auth.uid();
  v_row          public.records%rowtype;
  v_existing     bigint;
  v_new_version  bigint;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  -- 幂等：同一个 mutationId 只允许生效一次（§41、§42）
  select result_version into v_existing
    from public.applied_mutations
   where mutation_id = p_mutation_id
     and user_id = v_uid;

  if found then
    select * into v_row from public.records
     where id = p_record_id and user_id = v_uid;
    return jsonb_build_object(
      'status', 'already_applied',
      'version', coalesce(v_row.version, v_existing),
      'record', case when v_row.id is null then null else to_jsonb(v_row) end
    );
  end if;

  -- 锁定该行，保证 version 检查与写入原子（§40）
  select * into v_row from public.records
   where id = p_record_id and user_id = v_uid
   for update;

  if not found then
    if p_operation <> 'create' then
      return jsonb_build_object('status', 'record_not_found', 'version', null, 'record', null);
    end if;

    perform public.validate_record_creation_payload(p_payload);

    insert into public.records (
      id, user_id, type, content, progress, deadline_local_date, parent_id,
      created_at_utc, created_timezone, created_local_date,
      updated_at_utc, updated_timezone,
      completed_at_utc, completed_timezone, deleted_at_utc,
      version, server_updated_at
    ) values (
      p_record_id,
      v_uid,
      coalesce(p_payload ->> 'type', 'idea'),
      coalesce(p_payload ->> 'content', ''),
      -- 进度属于大事和进展；截止日只属于大事；parent_id 只属于进展。
      -- 与客户端 createRecord 的行为一致，也是上面那三条 CHECK
      -- 能一直成立的前提。
      case when coalesce(p_payload ->> 'type', 'idea') in ('project', 'log')
           then (p_payload ->> 'progress')::int
           else null
      end,
      case when coalesce(p_payload ->> 'type', 'idea') = 'project'
           then (p_payload ->> 'deadlineLocalDate')::date
           else null
      end,
      -- nullif 挡掉空字符串：`''::uuid` 会直接抛错，
      -- 而空字符串在语义上就等于「没有父级」。
      case when coalesce(p_payload ->> 'type', 'idea') = 'log'
           then nullif(p_payload ->> 'parentId', '')::uuid
           else null
      end,
      coalesce((p_payload ->> 'createdAtUtc')::timestamptz, now()),
      coalesce(p_payload ->> 'createdTimezone', 'UTC'),
      coalesce((p_payload ->> 'createdLocalDate')::date, (now() at time zone 'UTC')::date),
      coalesce((p_payload ->> 'updatedAtUtc')::timestamptz, now()),
      p_payload ->> 'updatedTimezone',
      (p_payload ->> 'completedAtUtc')::timestamptz,
      p_payload ->> 'completedTimezone',
      (p_payload ->> 'deletedAtUtc')::timestamptz,
      1,
      now()
    )
    returning * into v_row;

    v_new_version := v_row.version;

  else
    -- 乐观并发控制：期望版本与当前版本不一致 → 交给客户端做三方比较
    if p_expected_version is null or p_expected_version <> v_row.version then
      return jsonb_build_object(
        'status', 'version_conflict',
        'version', v_row.version,
        'record', to_jsonb(v_row)
      );
    end if;

    update public.records
       set content            = coalesce(p_payload ->> 'content', content),
           -- type 在触发器里是不可变的，所以用当前行的 type 判断即可。
           -- parent_id 刻意不出现在 SET 里：它是不可变字段。
           progress           = case
                                  when v_row.type in ('project', 'log') and p_payload ? 'progress'
                                  then (p_payload ->> 'progress')::int
                                  else progress
                                end,
           deadline_local_date = case
                                  when v_row.type = 'project' and p_payload ? 'deadlineLocalDate'
                                  then (p_payload ->> 'deadlineLocalDate')::date
                                  else deadline_local_date
                                end,
           updated_at_utc     = coalesce((p_payload ->> 'updatedAtUtc')::timestamptz, updated_at_utc),
           updated_timezone   = coalesce(p_payload ->> 'updatedTimezone', updated_timezone),
           completed_at_utc   = case
                                  when p_payload ? 'completedAtUtc'
                                  then (p_payload ->> 'completedAtUtc')::timestamptz
                                  else completed_at_utc
                                end,
           completed_timezone = case
                                  when p_payload ? 'completedTimezone'
                                  then p_payload ->> 'completedTimezone'
                                  else completed_timezone
                                end,
           deleted_at_utc     = case
                                  when p_payload ? 'deletedAtUtc'
                                  then (p_payload ->> 'deletedAtUtc')::timestamptz
                                  else deleted_at_utc
                                end,
           version            = version + 1,
           server_updated_at  = now()
     where id = p_record_id and user_id = v_uid
     returning * into v_row;

    v_new_version := v_row.version;
  end if;

  insert into public.applied_mutations (mutation_id, user_id, record_id, result_version)
  values (p_mutation_id, v_uid, p_record_id, v_new_version)
  on conflict (mutation_id) do nothing;

  return jsonb_build_object(
    'status', 'applied',
    'version', v_new_version,
    'record', to_jsonb(v_row)
  );
end;
$$;
