-- Objects db/schema.sql references that Supabase provides but vanilla Postgres
-- does not. Applied before the schema when building a test database.
--
-- The auth.* functions mirror Supabase's own definitions: both read the
-- `request.jwt.claims` GUC that PostgREST/Realtime sets per connection, and both
-- answer null when nothing set it. The backend connects as `postgres` and
-- bypasses RLS everywhere except the three Realtime surfaces (messaging,
-- notifications, signatures), so an ordinary in-process test still sees null.
--
-- These used to be hardcoded to `'{}'::jsonb` and `null`. Every RLS policy in
-- schema.sql reads `auth.jwt() ->> 'sub'`, so with a constant stub every policy
-- evaluated to null, every SELECT under `authenticated` returned zero rows, and
-- an RLS test could not tell a policy that works from a policy that denies
-- everything. Reading the GUC is what makes `tests/support/rlsSession.ts` able
-- to assume an identity.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb
$$;
create or replace function auth.uid() returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')
$$;

do $$ begin
  if not exists (select 1 from pg_publication where pubname='supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
