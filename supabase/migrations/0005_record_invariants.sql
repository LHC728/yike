-- 0005：追加数据库红线；历史迁移不改，存量记录逐列保持原样。
-- R21 的创建校验在 0004 RPC 中，本迁移不再次替换 RPC。
create or replace function public.records_created_fields_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.type is distinct from old.type
     or new.created_at_utc is distinct from old.created_at_utc
     or new.created_timezone is distinct from old.created_timezone
     or new.created_local_date is distinct from old.created_local_date
     or new.parent_id is distinct from old.parent_id then
    raise exception using errcode = '23514', message = 'created_fields_are_immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists records_created_fields_immutable on public.records;
create trigger records_created_fields_immutable
  before update on public.records
  for each row execute function public.records_created_fields_immutable();

create or replace function public.records_touch()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if new.version < old.version then
      raise exception using errcode = '23514', message = 'version_must_increase';
    elsif new.version = old.version then
      -- 普通直接 UPDATE 未提供版本时仍自动 +1；RPC 已显式 +1，不能再加一次。
      new.version := old.version + 1;
    end if;
  end if;
  new.server_updated_at := now();
  return new;
end;
$$;
