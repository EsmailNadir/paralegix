-- ---------- extensions ----------
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive emails
create extension if not exists pg_trgm;    -- indexed substring search

-- ---------- shared trigger fn: updated_at ----------
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

