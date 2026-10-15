-- =====================================================================
-- REFERENCE CATALOG (global, NOT tenant-scoped)
-- Read-only shared lists firms pick from (copy-on-adopt). Written only by the
-- import scripts in db/seed/, never by app request paths. Defined before the
-- per-firm tables below so their inline catalog_* FKs resolve. (migration 0083)
-- =====================================================================

create table if not exists court_catalog (
  id              uuid primary key default gen_random_uuid(),
  source          text not null default 'courtlistener',
  source_id       text,
  full_name       text not null,
  short_name      text,
  citation_abbrev text,
  jurisdiction    text,                                    -- 'federal' | 'state'
  court_type      text,                                    -- 'appellate' | 'trial' | 'supreme' | 'district' | ...
  state           text,
  url             text,
  in_use          boolean not null default true,
  search          tsvector generated always as (
                    to_tsvector('english',
                      coalesce(full_name,'') || ' ' || coalesce(short_name,'') || ' ' ||
                      coalesce(citation_abbrev,'') || ' ' || coalesce(state,''))
                  ) stored,
  created_at      timestamptz not null default now(),
  unique (source, source_id)
);
create index if not exists court_catalog_search_gin on court_catalog using gin (search);
create index if not exists court_catalog_state_idx on court_catalog (state, court_type);

create table if not exists utbms_codes (
  id           uuid primary key default gen_random_uuid(),
  code         text not null,
  name         text not null,
  code_type    text not null check (code_type in ('task','activity','expense')),
  practice_set text,
  is_active    boolean not null default true,
  unique (code)
);
create index if not exists utbms_codes_type_idx on utbms_codes (code_type, practice_set);

-- =====================================================================
-- MATTERS (+ junctions, notes)
-- =====================================================================

create table if not exists practice_areas (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  name                text not null,
  sort_order          int,
  created_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);

create table if not exists courts (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  name                text not null,
  abbreviation        text,
  city                text,
  state               text,
  address             text,
  court_type          text,
  sort_order          int,
  -- provenance link to the global court_catalog row this was adopted from
  -- (migration 0083); null = pure custom court. The copy is freely editable;
  -- the link only drives the "already added" indicator + double-import guard.
  catalog_court_id    uuid references court_catalog(id) on delete set null,
  created_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists courts_catalog_idx on courts (law_firm_id, catalog_court_id) where catalog_court_id is not null;

-- Firm-configurable note types and note templates (migration 0150), so a firm
-- can extend the built-in note-type vocabulary and reusable note templates
-- from the note composer instead of being limited to the hardcoded frontend
-- lists. `note_types.value` is the slug actually stored in *_notes.note_type;
-- `label` is the display text. `color` (migration 0153) is a StatusVariant key
-- (e.g. "info", "purple"); null falls back to the built-in/default color. A row
-- whose value matches a built-in slug can exist purely to carry a color
-- override, without introducing a second dropdown option for that slug.
