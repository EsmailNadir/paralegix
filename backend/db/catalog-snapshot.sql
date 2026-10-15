-- Canonical, order-independent description of the public schema.
--
-- Used by scripts/check-catalog-parity.sh to compare a database built from
-- db/schema.sql against one migrated from a baseline. Every row is one catalog
-- fact, prefixed by its kind, and the whole set is ordered by text, so two
-- databases that hold the same objects produce byte-identical output no matter
-- what order the objects were created in.
--
-- Physical column order is deliberately NOT compared. A migration appends a
-- column; db/schema.sql declares it in the designed position rule 3 of the
-- redesign proposal's Section 9 asks for. Both are correct and the difference
-- is invisible to every reader, because repositories and Drizzle name columns.
-- Ordinal position is therefore excluded while the column itself is compared in
-- full: type, nullability, default and generation expression.
\pset tuples_only on
\pset format unaligned
\pset pager off

with
column_facts as (
  select format(
    'COLUMN  %s.%s type=%s null=%s default=%s generated=%s',
    c.relname, a.attname,
    format_type(a.atttypid, a.atttypmod),
    case when a.attnotnull then 'no' else 'yes' end,
    coalesce(pg_get_expr(d.adbin, d.adrelid), '-'),
    case a.attgenerated when 's' then coalesce(pg_get_expr(d.adbin, d.adrelid), 'stored') else '-' end
  ) as fact
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where n.nspname = 'public'
    and c.relkind in ('r', 'v', 'm', 'p')
    and a.attnum > 0
    and not a.attisdropped
),
constraint_facts as (
  select format('CONSTR  %s.%s %s', c.relname, con.conname, pg_get_constraintdef(con.oid)) as fact
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
index_facts as (
  select format('INDEX   %s', pg_get_indexdef(i.indexrelid)) as fact
  from pg_index i
  join pg_class c on c.oid = i.indrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
trigger_facts as (
  select format('TRIGGER %s', pg_get_triggerdef(t.oid)) as fact
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and not t.tgisinternal
),
function_facts as (
  select format('FUNC    %s(%s) -> %s | %s',
    p.proname,
    pg_get_function_identity_arguments(p.oid),
    pg_get_function_result(p.oid),
    md5(p.prosrc)
  ) as fact
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
),
policy_facts as (
  select format('POLICY  %s.%s cmd=%s roles=%s using=%s check=%s',
    c.relname, pol.polname, pol.polcmd,
    coalesce((select string_agg(r.rolname, ',' order by r.rolname) from pg_roles r where r.oid = any(pol.polroles)), '-'),
    coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-'),
    coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
  ) as fact
  from pg_policy pol
  join pg_class c on c.oid = pol.polrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
),
rls_facts as (
  select format('RLS     %s enabled=%s forced=%s', c.relname,
    case when c.relrowsecurity then 'yes' else 'no' end,
    case when c.relforcerowsecurity then 'yes' else 'no' end) as fact
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
),
relation_facts as (
  select format('REL     %s kind=%s', c.relname, c.relkind) as fact
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'S')
),
view_facts as (
  select format('VIEW    %s | %s', c.relname, md5(pg_get_viewdef(c.oid))) as fact
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('v', 'm')
),
-- Grants matter as much as policies here: a table with RLS enabled and no
-- `grant select ... to authenticated` answers "permission denied" rather than
-- "no rows", so losing a grant silently disables a whole Realtime surface.
grant_facts as (
  select format('GRANT   %s %s', c.relname, coalesce(array_to_string(c.relacl, ' '), '-')) as fact
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p', 'S') and c.relacl is not null
),
function_grant_facts as (
  select format('GRANTFN %s(%s) %s', p.proname,
    pg_get_function_identity_arguments(p.oid),
    array_to_string(p.proacl, ' ')) as fact
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proacl is not null
),
comment_facts as (
  select format('COMMENT %s.%s = %s', c.relname, a.attname, d.description) as fact
  from pg_description d
  join pg_class c on c.oid = d.objoid
  join pg_namespace n on n.oid = c.relnamespace
  join pg_attribute a on a.attrelid = c.oid and a.attnum = d.objsubid
  where n.nspname = 'public' and d.objsubid > 0
),
all_facts as (
  select fact from relation_facts
  union all select fact from column_facts
  union all select fact from constraint_facts
  union all select fact from index_facts
  union all select fact from trigger_facts
  union all select fact from function_facts
  union all select fact from policy_facts
  union all select fact from rls_facts
  union all select fact from view_facts
  union all select fact from grant_facts
  union all select fact from function_grant_facts
  union all select fact from comment_facts
)
select fact from all_facts order by fact;
