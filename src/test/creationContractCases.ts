/** D1 与 Supabase 的创建校验共用这份输入，不用两套不同样本声称语义一致。 */
export const INVALID_CREATION_FIELDS = [
  ['createdAtUtc', 'not-a-date'], ['createdAtUtc', '2026-02-30T00:00:00.000Z'],
  ['createdAtUtc', '2026-01-01'], ['createdAtUtc', '2026-10-06T25:00:00Z'],
  ['createdAtUtc', '2026-10-06T01:00:60Z'], ['createdAtUtc', '0000-01-01T00:00:00Z'],
  ['createdAtUtc', '2026-10-06T00:00:00+08:00'], ['createdAtUtc', '2026-10-06T00:00:00.1234567Z'],
  ['createdAtUtc', 'now'], ['createdAtUtc', 'infinity'], ['createdAtUtc', ''],
  ['createdAtUtc', 42], ['createdAtUtc', true], ['createdAtUtc', {}],
  ['createdLocalDate', '2026-99-99'], ['createdLocalDate', '2026-02-30'],
  ['createdLocalDate', '0000-01-01'], ['createdLocalDate', '2026-10-6'],
  ['createdLocalDate', ''], ['createdLocalDate', []], ['createdLocalDate', 99],
  ['createdTimezone', 'invalid/zone'], ['createdTimezone', 'EST'],
  ['createdTimezone', 'Europe/Not_Real'], ['createdTimezone', ''],
  ['createdTimezone', {}], ['createdTimezone', 44],
] as const

export const VALID_CREATION_UTC = [
  '0001-01-01T00:00:00Z', '0099-02-28T23:59:59Z', '2000-02-29T00:00:00.123456Z',
  '2026-10-06T01:00:00+00:00', '2026-10-06T01:00:00.123456+00:00', '9999-12-31T23:59:59Z',
] as const

export const VALID_CREATION_DATES = ['0001-01-01', '0099-02-28', '2000-02-29', '9999-12-31'] as const

export const VALID_CREATION_TIMEZONES = [
  'UTC', 'GMT', 'Etc/UTC', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Calcutta',
  'Europe/Kyiv', 'Europe/Kiev', 'US/Pacific',
] as const
