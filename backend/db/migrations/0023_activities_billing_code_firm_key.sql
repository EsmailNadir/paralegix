-- migration-mode: expand
--
-- A time entry's charge code and an expense's category belong to the
-- activity's own firm.
--
-- Pre:  activities.billing_code_id references billing_codes(id) alone, so a
--       row could name another firm's code. Every existing row names a code
--       of its own firm; the block below proves it and stops otherwise.
-- Post: the key is (law_firm_id, billing_code_id) -> billing_codes
--       (law_firm_id, id). Deleting a code still clears only billing_code_id.
--       The single-column index is replaced by one leading with
--       (law_firm_id, billing_code_id), which the composite key's delete
--       probe needs.

do $$
declare
  crossed int;
begin
  select count(*) into crossed
    from activities a
    join billing_codes c on c.id = a.billing_code_id
   where c.law_firm_id <> a.law_firm_id;
  if crossed > 0 then
    raise exception 'activities: % row(s) name another firm''s billing code; resolve them by hand before applying 0023', crossed;
  end if;
end $$;

alter table activities drop constraint if exists activities_billing_code_id_fkey;

alter table activities
  add constraint activities_law_firm_id_billing_code_id_fkey
  foreign key (law_firm_id, billing_code_id) references billing_codes (law_firm_id, id)
  on delete set null (billing_code_id);

create index if not exists activities_firm_billing_code_fk_idx
  on activities (law_firm_id, billing_code_id) where billing_code_id is not null;

drop index if exists activities_billing_code_fk_idx;
