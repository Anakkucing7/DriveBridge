-- Run once in the SQL Editor of the Supabase project selected for DriveBridge.
-- All objects are prefixed; existing homecare tables are untouched.
begin;

create table public.drivebridge_request_limits (
  network_hash text not null check (network_hash ~ '^[a-f0-9]{64}$'),
  action text not null check (action in ('inspect', 'download')),
  requests integer not null default 1,
  expires_at timestamptz not null default (now() + interval '2 minutes'),
  primary key (network_hash, action)
);
create index drivebridge_request_limits_expiry on public.drivebridge_request_limits (expires_at);
alter table public.drivebridge_request_limits enable row level security;
revoke all on public.drivebridge_request_limits from public, anon, authenticated;
grant select, insert, update, delete on public.drivebridge_request_limits to service_role;

-- SECURITY INVOKER: the server's secret key supplies service_role permissions.
create function public.drivebridge_consume_request(p_key text, p_action text, p_limit integer)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  used integer;
begin
  if p_key !~ '^[a-f0-9]{64}$' or p_action not in ('inspect', 'download')
    or p_limit not between 1 and 100 then
    raise exception 'Invalid rate limit arguments';
  end if;
  delete from public.drivebridge_request_limits where expires_at < now();
  insert into public.drivebridge_request_limits (network_hash, action)
    values (p_key, p_action)
    on conflict (network_hash, action) do update
      set requests = least(public.drivebridge_request_limits.requests + 1, p_limit + 1)
    returning requests into used;
  return used <= p_limit;
end;
$$;
revoke all on function public.drivebridge_consume_request(text, text, integer) from public, anon, authenticated;
grant execute on function public.drivebridge_consume_request(text, text, integer) to service_role;

commit;

