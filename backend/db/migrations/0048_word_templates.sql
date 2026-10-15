-- migration-mode: expand
-- The Word-first template library: a .docx or fillable PDF is stored byte for
-- byte and filled in place, and an HTML template keeps its body in storage.
-- A separate table from `templates`, so the two existing template experiences
-- are untouched and this one can be dropped by a single contract migration.
--
-- Pre:  no table named word_templates.
-- Post: word_templates exists, empty, firm-scoped with unique (law_firm_id, id);
--       a row of type html points at its body (html_object_path) and a docx or
--       pdf-form row at its source file (source_object_path), never both;
--       at most one docx and one pdf-form template per firm share a name,
--       compared case-insensitively. Old code never reads it.

create table if not exists word_templates (
  id                   uuid not null default gen_random_uuid(),
  law_firm_id          uuid not null references law_firms(id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 200),
  type                 text not null check (type in ('html', 'docx', 'pdf-form')),
  -- Storage object holding an html template's body.
  html_object_path     text,
  -- Storage object holding a docx or pdf-form template's original file.
  source_object_path   text,
  original_file_name   text check (original_file_name is null or length(original_file_name) <= 255),
  fields               text[] not null default '{}',
  repeaters            jsonb not null default '[]',
  -- Images embedded in an html template: [{ id, object_path, mime_type, file_name }].
  assets               jsonb not null default '[]',
  created_by           text references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  constraint word_templates_body_present check (
    (type = 'html' and html_object_path is not null and source_object_path is null)
    or (type in ('docx', 'pdf-form') and source_object_path is not null and html_object_path is null)
  )
);

-- The library lists one firm's templates by name.
create index if not exists word_templates_firm_name_idx
  on word_templates (law_firm_id, name);
-- Same-name detection on upload, and the guarantee behind it: two concurrent
-- uploads of one name cannot both create a row.
create unique index if not exists word_templates_firm_type_name_key
  on word_templates (law_firm_id, type, lower(name))
  where type in ('docx', 'pdf-form');
create index if not exists word_templates_created_by_idx
  on word_templates (created_by);

drop trigger if exists set_updated_at on word_templates;
create trigger set_updated_at before update on word_templates
  for each row execute function set_updated_at();

comment on table word_templates is 'Word-first template library: an uploaded .docx or fillable PDF filled in place, or an HTML template whose body lives in storage.';
comment on column word_templates.source_object_path is 'Storage object of the original .docx or .pdf. Replaced by writing a new versioned object, repointing this column, then deleting the old one.';
