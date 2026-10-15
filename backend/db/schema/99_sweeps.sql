-- =====================================================================
-- WHOLE-SCHEMA SWEEPS (must be last)
--   Both blocks below iterate over every table that exists AT THE MOMENT
--   THEY RUN. They therefore have to sit at the very end of this file.
--
--   They used to sit in the middle, around line 3030, ahead of thirteen
--   tables (conflict_check_records, matter_field_defs, matter_stage_pipelines,
--   matter_stages, matter_contacts, activity_log, task_subtasks,
--   cron_pass_state, digest_sends, lead_stages, leads, intake_form_templates,
--   intake_submissions). A single clean application therefore left those
--   thirteen without their updated_at trigger and still carrying the hard FKs
--   to users/clients the first block exists to remove. The defect was masked
--   because schema.sql could not be applied in one pass at all: the two psql
--   passes people used instead re-ran these sweeps after every table existed.
-- =====================================================================
-- NO SOFT-REFERENCE SWEEP
--   There used to be a block here that dropped every foreign key pointing at
--   `users` or `clients`, so that a deleted account or a detached client left
--   its id behind as an unconstrained value rather than rejecting the delete.
--   Migration 0224 retired the `users` half and 0225 the `clients` half.
--
--   Both premises had expired. The privacy erase stopped deleting a `users`
--   row long ago; it anonymizes and keeps it as a tombstone, so the keys
--   pointing at it resolve. And `clients.service.removeClient` refuses a
--   client with billing, trust or legal-hold records and deletes every child
--   itself, in one transaction, so nothing was relying on the absent keys
--   either. What the sweep actually bought was that a typo, a stale id or a
--   path that forgot to check could leave a row naming something that does
--   not exist, with no error anywhere.
--
--   The consequence for reading this file: what is declared above is what a
--   database has. No block below removes a constraint.
-- =====================================================================

-- =====================================================================
-- updated_at triggers on every table that has the column
-- =====================================================================
do $$
declare r record;
begin
  for r in
    select c.table_name from information_schema.columns c
    where c.table_schema = 'public' and c.column_name = 'updated_at'
  loop
    execute format('drop trigger if exists set_updated_at on %I', r.table_name);
    execute format('create trigger set_updated_at before update on %I for each row execute function set_updated_at()', r.table_name);
  end loop;
end $$;
