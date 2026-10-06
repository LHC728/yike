-- 0004：只重建不可变字段触发器，绝不重建表或搬运用户数据。
-- SQL 的 NULL <> value 结果是 NULL，WHEN 会跳过；IS NOT 同时守住两向 NULL 与 id。
drop trigger if exists records_created_fields_immutable;
create trigger records_created_fields_immutable
before update on records
for each row
when new.created_at_utc     is not old.created_at_utc
  or new.created_local_date is not old.created_local_date
  or new.created_timezone   is not old.created_timezone
  or new.id                 is not old.id
  or new.user_id            is not old.user_id
  or new.type               is not old.type
  or new.parent_id          is not old.parent_id
begin
  select raise(abort, 'created_fields_are_immutable');
end;
