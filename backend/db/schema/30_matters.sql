create table if not exists matter_categories (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  name                text not null,
  parent_id           uuid,
  path                text,
  level               int not null default 0,
  sort_order          int not null default 0,
  created_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists matter_categories_parent_idx on matter_categories (parent_id);

drop trigger if exists set_updated_at on matter_categories;
create trigger set_updated_at before update on matter_categories
  for each row execute function set_updated_at();

create table if not exists matter_stage_pipelines (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  practice_area_id  uuid references practice_areas(id) on delete set null,
  name              text not null,
  is_default        boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists matter_stage_pipelines_firm_pa_idx
  on matter_stage_pipelines (law_firm_id, practice_area_id);
-- At most one default pipeline per (firm, scope). A plain unique index treats
-- NULLs as always distinct, so coalesce collapses the nullable
-- practice_area_id to a sentinel to make unscoped rows conflict too.
create unique index if not exists matter_stage_pipelines_one_default_idx
  on matter_stage_pipelines (law_firm_id, coalesce(practice_area_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_default;

-- Ordered stage a matter progresses through (kanban pipeline), belonging to
-- exactly one matter_stage_pipelines row. is_closed marks a terminal stage.
create table if not exists matter_stages (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  pipeline_id       uuid not null references matter_stage_pipelines(id) on delete cascade,
  name              text not null,
  color             text,
  sort_order        integer not null default 0,
  is_closed         boolean not null default false,
  parent_stage_id   uuid references matter_stages(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists matter_stages_parent_idx on matter_stages (law_firm_id, parent_stage_id);
create index if not exists matter_stages_pipeline_idx on matter_stages (law_firm_id, pipeline_id);

create table if not exists matters (
  id                  uuid not null default gen_random_uuid(),
  law_firm_id         uuid not null references law_firms(id) on delete cascade,
  name                text not null,
  matter_number         text,
  matter_reference_id   text not null,
  description         text,
  status              text not null default 'active'    -- vocabulary mirrors VALID_MATTER_STATUSES (matters.validation.js)
                      check (status in ('active','pending','on_hold','completed','blocked','closed','archived')),
  -- Manual "payment ongoing" override: money still expected on a functionally-done
  -- matter (payment plan, or a balance expected but not yet invoiced). Orthogonal
  -- to status. The effective flag the app shows is (this) OR (outstanding invoice
  -- balance), surfaced only on terminal statuses. See matters.repository.js hydrate.
  payment_ongoing     boolean not null default false,
  category            text,
  practice_area_id    uuid,
  court_id            uuid,
  lead_user_id        text references users(id) on delete restrict,
  custom_fields       jsonb not null default '{}',
  -- Legal hold: when set, the record is preserved against destruction (a
  -- litigation hold blocks deletion). Enforced in the application delete paths.
  -- Billing preferences and key dates (migration 0116). `stage_id` and
  -- `stage_pipeline_id` are NOT here: they reference matter_stages /
  -- matter_stage_pipelines, which this file creates further down, so they are
  -- added in the DEFERRED MATTER STAGE COLUMNS block after those tables exist.
  billing_method      text not null default 'hourly'
                        check (billing_method in ('hourly','flat','contingency','pro_bono')),
  is_billable         boolean not null default true,
  budget_cents        bigint check (budget_cents is null or budget_cents >= 0),
  budget_includes_expenses boolean not null default true,
  contingency_percent numeric check (contingency_percent is null or (contingency_percent >= 0 and contingency_percent <= 100)),
  open_date           date,
  close_date          date,
  statute_of_limitations_date date,
  created_by          text references users(id) on delete restrict,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  unique (law_firm_id, matter_reference_id),
  -- single-column FKs: ON DELETE SET NULL on a composite (incl. law_firm_id) FK
  -- would null the tenant id too, so these reference only the parent id.
  foreign key (practice_area_id) references practice_areas (id) on delete set null,
  foreign key (court_id)         references courts (id) on delete set null
);
create index if not exists matters_firm_status_idx on matters (law_firm_id, status);

create table if not exists matter_members (
  matter_id           uuid not null,
  user_id           text not null references users(id) on delete cascade,
  law_firm_id       uuid not null,
  role              text not null default 'member' check (role in ('lead','member')),
  hourly_rate_cents bigint check (hourly_rate_cents is null or hourly_rate_cents >= 0),
  -- `joined_at` is nullable and unset for a row created any way other than an
  -- accepted invitation, so it is NOT a creation stamp; this table still owes a
  -- `created_at`. `role` and the rate are updated in place, which is what the
  -- `updated_at` added by migration 0211 records.
  joined_at         timestamptz,
  updated_at        timestamptz not null default now(),
  primary key (matter_id, user_id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade
);
create index if not exists matter_members_user_idx on matter_members (user_id);
-- The primary key (matter_id, user_id) serves a lookup by matter but not by
-- (law_firm_id, matter_id), which is the composite foreign key's shape and the
-- one a matter delete cascades on (migration 0206).
create index if not exists matter_members_firm_matter_idx
  on matter_members (law_firm_id, matter_id);

create table if not exists matter_clients (
  matter_id     uuid not null,
  client_id   uuid not null,
  law_firm_id uuid not null,
  -- Share of this matter's invoices this client pays, in basis points
  -- (10000 = 100%). Null means no split is configured. Basis points rather than
  -- a percentage for the same reason money is cents: three equal shares must
  -- come to exactly 100%. The cross-row rule that a matter's portions sum to
  -- 10000 is enforced in the service, inside the transaction that replaces the
  -- junction set, since a table check cannot span rows.
  billing_portion_bp integer
    constraint matter_clients_billing_portion_bp_range
    check (billing_portion_bp is null or (billing_portion_bp >= 0 and billing_portion_bp <= 10000)),
  -- Mutable: rows are inserted ON CONFLICT DO NOTHING and their portion is then
  -- updated in place, so a row survives across edits (migration 0211).
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (matter_id, client_id),
  foreign key (law_firm_id, matter_id)   references matters (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade
);
create index if not exists matter_clients_client_idx on matter_clients (client_id);

-- Hierarchical matter category tree (each row may reference a parent in the same
-- table). parent_id is intentionally not FK-constrained; the application enforces
-- tree integrity (no self-parent, no cycles, no delete-with-children).

-- Firm-defined custom fields applied to matters. practice_area_id NULL = applies
-- to every matter. Values are stored on matters.custom_fields keyed by this id.
create table if not exists matter_field_defs (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  practice_area_id  uuid references practice_areas(id) on delete cascade,
  label             text not null,
  field_type        text not null default 'text'
                    check (field_type in ('text','textarea','number','currency','date','select','multiselect','checkbox','url','email','phone')),
  options           jsonb not null default '[]',
  help_text         text,
  required          boolean not null default false,
  sort_order        integer not null default 0,
  archived          boolean not null default false,
  created_by        text references users(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists matter_field_defs_firm_pa_idx on matter_field_defs (law_firm_id, practice_area_id);

-- A named, optionally practice-area-scoped stage pipeline a matter can be
-- assigned to. Multiple pipelines may share the same scope (including
-- multiple unscoped firm-wide pipelines); at most one per scope is is_default.

-- Links a directory contact to a matter (opposing counsel, judge, etc.).
--
-- This holds only what is genuinely per-matter: the role that contact plays on
-- THIS matter, matter-specific notes, and display order. Name, organization and
-- contact details live on the `contacts` row it points at, so they are edited
-- once and correct on every matter. (migration 0135 -- before it, each row
-- carried its own free-typed copy of the person.)
create table if not exists matter_contacts (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null,
  matter_id         uuid not null,
  contact_id        uuid not null,
  role              text not null default 'other'
                    check (role in ('opposing_counsel','opposing_party','co_counsel','judge','witness','expert','adjuster','court_clerk','mediator','guardian_ad_litem','other')),
  notes             text,
  sort_order        integer not null default 0,
  created_by        text references users(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  -- One link per contact per matter; the role lives on the link, so a contact
  -- who changes hats on a matter is an update, not a second row.
  constraint matter_contacts_unique_link unique (law_firm_id, matter_id, contact_id),
  foreign key (law_firm_id, matter_id) references matters (law_firm_id, id) on delete cascade,
  constraint matter_contacts_contact_fk
    foreign key (law_firm_id, contact_id) references contacts (law_firm_id, id) on delete cascade
);
create index if not exists matter_contacts_matter_idx on matter_contacts (matter_id);
create index if not exists matter_contacts_contact_idx on matter_contacts (law_firm_id, contact_id);

-- ---------- leads pipeline + intake forms (0146) ----------
-- Prospects are separate from clients so they never count against plan client
-- limits and never surface ClientDetail tabs that assume financial history.

create table if not exists lead_stages (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  practice_area_id  uuid references practice_areas(id) on delete set null,
  name              text not null,
  color             text,
  sort_order        integer not null default 0,
  is_closed         boolean not null default false,
  parent_stage_id   uuid references lead_stages(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id)
);
create index if not exists lead_stages_firm_pa_idx on lead_stages (law_firm_id, practice_area_id);
create index if not exists lead_stages_parent_idx on lead_stages (law_firm_id, parent_stage_id);

create table if not exists leads (
  id                   uuid not null default gen_random_uuid(),
  law_firm_id          uuid not null references law_firms(id) on delete cascade,
  stage_id             uuid,
  stage_date           date,
  name                 text not null,
  email                text,
  phone                text,
  organization         text,
  referral_source      text,
  notes                text,
  disqualify_reason    text,
  converted_client_id  uuid,
  converted_matter_id  uuid,
  converted_at         timestamptz,
  created_by           text references users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  constraint leads_stage_fk
    foreign key (law_firm_id, stage_id) references lead_stages(law_firm_id, id) on delete set null,
  -- SINGLE column, deliberately, and not composite like leads_stage_fk above.
  -- ON DELETE SET NULL nulls EVERY column of the key it fires on, so a composite
  -- key carrying law_firm_id makes Postgres emit
  --     UPDATE ONLY leads SET law_firm_id = NULL, converted_matter_id = NULL ...
  -- against a NOT NULL column, and deleting a matter or client that a lead was
  -- converted into died on 23502 and surfaced as a 500. Same reasoning as
  -- matters.practice_area_id, matters.court_id and contacts.court_id, which are
  -- single column for exactly this hazard. Tenant scoping is the application's
  -- job on these columns; leads.law_firm_id keeps its own FK to law_firms.
  -- Introduced by migration 0184, since folded into this file with the rest of
  -- the chain.
  -- No foreign key on converted_client_id. It is a soft reference: deleting a
  -- client leaves the lead holding an id that no longer resolves.
  -- Migrations 0224 and 0225 retired the sweep that used to drop such keys, so
  -- a key declared here now survives. Adding one is a behaviour change: it
  -- would make deleting a converted client fail instead of leaving the id.
  constraint leads_converted_matter_fk
    foreign key (converted_matter_id) references matters(id) on delete set null
);
create index if not exists leads_firm_stage_idx on leads (law_firm_id, stage_id);
create index if not exists leads_firm_email_idx on leads (law_firm_id, lower(email)) where email is not null;


create table if not exists intake_form_templates (
  id                uuid not null default gen_random_uuid(),
  law_firm_id       uuid not null references law_firms(id) on delete cascade,
  practice_area_id  uuid references practice_areas(id) on delete set null,
  name              text not null,
  public_token      text not null,
  fields            jsonb not null default '[]'::jsonb,
  access_code_hash  text,
  is_active         boolean not null default true,
  created_by        text references users(id) on delete restrict,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  unique (public_token)
);
-- intake_form_templates_firm_idx removed by migration 0195: covered by
-- intake_form_templates_law_firm_id_id_key.

create table if not exists intake_submissions (
  id                       uuid not null default gen_random_uuid(),
  law_firm_id              uuid not null references law_firms(id) on delete cascade,
  intake_form_template_id  uuid not null,
  token                    text not null,
  field_values             jsonb not null default '{}'::jsonb,
  status                   text not null default 'sent'
    check (status in ('sent', 'completed', 'rejected')),
  delivery_status          text not null default 'sent'
    check (delivery_status in ('pending', 'sent', 'failed')),
  lead_id                  uuid,
  sent_to_email            text,
  sent_by                  text references users(id) on delete restrict,
  sent_at                  timestamptz,
  opened_at                timestamptz,
  submitted_ip             text,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz,
  primary key (id),
  unique (law_firm_id, id),
  unique (token),
  constraint intake_submissions_template_fk
    foreign key (law_firm_id, intake_form_template_id)
    references intake_form_templates(law_firm_id, id) on delete cascade,
  -- Single column, not (law_firm_id, lead_id). A composite key with ON DELETE
  -- SET NULL nulls EVERY column of the key, including the NOT NULL tenant
  -- column, so deleting a lead that had ever received or submitted an intake
  -- form failed with 23502 (migration 0187). Tenant scoping is unaffected:
  -- law_firm_id keeps its own CASCADE to law_firms and every read carries its
  -- own predicate.
  constraint intake_submissions_lead_fk
    foreign key (lead_id) references leads(id) on delete set null
);
create index if not exists intake_submissions_template_idx
  on intake_submissions (law_firm_id, intake_form_template_id);
create index if not exists intake_submissions_lead_idx
  on intake_submissions (law_firm_id, lead_id);

-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column leads.stage_date is 'Date associated with the lead''s current stage (e.g. a scheduled consultation or follow-up date). Not tied to stage_id changing.';
comment on column matter_clients.billing_portion_bp is 'Share of this matter''s invoices this client pays, in basis points (10000 = 100%). Null means no split is configured. Portions across a matter must sum to 10000; enforced in matterClients service, not by a table check.';
