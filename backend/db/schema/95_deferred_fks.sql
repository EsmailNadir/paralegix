-- =====================================================================
-- DEFERRED CROSS-TABLE FOREIGN KEYS
--   Two reasons a foreign key lives here rather than on its table:
--   a genuine circular dependency (invoices <-> billing_plan_periods), or a
--   plain forward reference to a table created later in this file. Either way
--   an inline declaration makes the whole file unappliable to an EMPTY
--   database, which is the one case this file exists to serve.
--
--   Every entry is guarded on pg_constraint, so re-applying is a no-op and an
--   existing database keeps the constraint it already has.
-- =====================================================================
do $$
begin
  -- note_links is defined after `tasks` now, but the deferred form is kept: the
  -- table is created in the notes block, which sits with the other note tables
  -- rather than being ordered around this one key.
  if not exists (select 1 from pg_constraint where conname = 'note_links_law_firm_id_task_id_fkey') then
    alter table note_links add constraint note_links_law_firm_id_task_id_fkey
      foreign key (law_firm_id, task_id) references tasks (law_firm_id, id) on delete cascade;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_plan_fk') then
    alter table invoices      add constraint invoices_plan_fk         foreign key (billing_plan_id) references billing_plans(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_plan_period_fk') then
    alter table invoices      add constraint invoices_plan_period_fk  foreign key (billing_plan_period_id) references billing_plan_periods(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'period_generated_invoice_fk') then
    alter table billing_plan_periods add constraint period_generated_invoice_fk foreign key (generated_invoice_id) references invoices(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'trust_txn_invoice_fk') then
    -- Tenant-scoped, matching the declaration on the table above. The
    -- single-column form this block used to add let a trust entry point at an
    -- invoice belonging to another firm; migration 0181 replaces it where it
    -- was already created that way.
    alter table trust_transactions add constraint trust_txn_invoice_fk foreign key (law_firm_id, invoice_id) references invoices(law_firm_id, id) on delete set null;
  end if;
end $$;

-- =====================================================================
-- DEFERRED MATTER STAGE COLUMNS
--   The only two `matters` columns that cannot be declared with the table:
--   both reference tables created above but AFTER `matters`, so an inline
--   declaration makes this file unappliable to an empty database. Every other
--   column migration 0116 added is now inline on `create table matters`.
-- =====================================================================
alter table matters
  add column if not exists stage_id uuid references matter_stages(id) on delete set null,
  add column if not exists stage_pipeline_id uuid references matter_stage_pipelines(id) on delete set null;
create index if not exists matters_firm_stage_idx on matters (law_firm_id, stage_id);
-- FK probe support (see migration 0130): deleting a stage, practice area or court.
create index if not exists matters_stage_fk_idx
  on matters (stage_id) where stage_id is not null;
create index if not exists matters_practice_area_idx
  on matters (practice_area_id) where practice_area_id is not null;
create index if not exists matters_stage_pipeline_idx
  on matters (stage_pipeline_id) where stage_pipeline_id is not null;
create index if not exists matters_court_idx
  on matters (court_id) where court_id is not null;
create index if not exists matters_firm_sol_idx on matters (law_firm_id, statute_of_limitations_date);

-- ---------- forward-migration index parity (0137-0145) ----------
-- Fresh databases must expose the same proven query support as databases that
-- reached this shape through numbered migrations.
create index if not exists matter_clients_firm_matter_idx
  on matter_clients (law_firm_id, matter_id, client_id);
create index if not exists matter_clients_firm_client_idx
  on matter_clients (law_firm_id, client_id);

create unique index if not exists calendar_mappings_entity_item_uidx
  on calendar_mappings (provider, user_id, entity_type, entity_id, item_key)
  nulls not distinct;
create index if not exists calendar_mappings_firm_idx
  on calendar_mappings (law_firm_id);
create index if not exists invoices_client_context_fk_idx
  on invoices (client_context_id) where client_context_id is not null;
create index if not exists matters_firm_created_idx
  on matters (law_firm_id, created_at desc, id asc);
create index if not exists tasks_firm_title_idx on tasks (law_firm_id, title);
create index if not exists document_requests_firm_matter_created_idx
  on document_requests (law_firm_id, matter_id, created_at desc, id desc);
create index if not exists signature_sessions_settled_sweep_idx
  on signature_sessions (updated_at)
  where status in ('completed', 'cancelled', 'expired');

create index if not exists clients_name_trgm_idx on clients using gin (name gin_trgm_ops);
create index if not exists clients_email_trgm_idx on clients using gin ((email::text) gin_trgm_ops);
create index if not exists clients_org_trgm_idx on clients using gin (organization gin_trgm_ops);
create index if not exists users_name_trgm_idx on users using gin (name gin_trgm_ops);
create index if not exists users_email_trgm_idx on users using gin ((email::text) gin_trgm_ops);
create index if not exists matters_name_trgm_idx on matters using gin (name gin_trgm_ops);
create index if not exists matters_number_trgm_idx on matters using gin (matter_number gin_trgm_ops);
create index if not exists matters_desc_trgm_idx on matters using gin (description gin_trgm_ops);
create index if not exists tasks_title_trgm_idx on tasks using gin (title gin_trgm_ops);
create index if not exists tasks_desc_trgm_idx on tasks using gin (description gin_trgm_ops);
create index if not exists contacts_name_trgm_idx on contacts using gin (name gin_trgm_ops);
create index if not exists contacts_org_trgm_idx on contacts using gin (organization gin_trgm_ops);
create index if not exists contacts_email_trgm_idx on contacts using gin ((email::text) gin_trgm_ops);
create index if not exists contacts_title_trgm_idx on contacts using gin (title gin_trgm_ops);
create index if not exists contacts_phone_trgm_idx on contacts using gin (phone gin_trgm_ops);
create index if not exists tasks_firm_created_idx
  on tasks (law_firm_id, created_at desc, id asc);

create index if not exists trust_txn_firm_date_created_idx
  on trust_transactions (law_firm_id, txn_date desc, created_at desc);
create index if not exists trust_txn_account_balance_idx
  on trust_transactions (law_firm_id, trust_account_id, client_id)
  include (status, type, amount_cents) where status <> 'void';
create index if not exists trust_txn_client_balance_idx
  on trust_transactions (law_firm_id, client_id, trust_account_id)
  include (status, type, amount_cents) where status <> 'void';
create index if not exists trust_recon_firm_date_idx
  on trust_reconciliations (law_firm_id, reconciliation_date desc, created_at desc, id desc);
create index if not exists trust_recon_firm_account_date_idx
  on trust_reconciliations
    (law_firm_id, trust_account_id, reconciliation_date desc, created_at desc, id desc);
create index if not exists audit_events_firm_action_time_idx
  on audit_events (law_firm_id, action, created_at desc, id desc);
create index if not exists audit_events_firm_actor_time_idx
  on audit_events (law_firm_id, actor_uid, created_at desc, id desc);
create index if not exists signature_sessions_firm_completed_path_idx
  on signature_sessions (law_firm_id, object_path) where status = 'completed';
