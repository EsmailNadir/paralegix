-- migration-mode: expand
-- Precondition: activity_billed_immutable() freezes a billed time entry's hours,
--   rate_cents, date, charge code, client split, billable flag and matter, but
--   not resolved_rate_cents, the stamped rate that readers price the entry at.
-- Postcondition: resolved_rate_cents is frozen with them while a line item on a
--   non-voided invoice names the entry. Tightens a guard only; no data changes,
--   and an entry whose invoice is voided stays editable. `create or replace
--   function` rebinds the existing trigger.
create or replace function activity_billed_immutable() returns trigger
  language plpgsql as $$
declare
  line_kind text := case old.kind when 'time' then 'time_entry' else old.kind end;
  placed boolean;
begin
  -- A voided invoice was cancelled by the firm, so its line items no longer
  -- hold the work they name.
  select exists (
    select 1 from invoice_line_items li
      join invoices i on i.law_firm_id = li.law_firm_id and i.id = li.invoice_id
     where li.law_firm_id = old.law_firm_id
       and li.kind = line_kind
       and li.source_id = old.id::text
       and i.status <> 'voided'
  ) into placed;
  if not placed then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'this % is on an invoice and cannot be deleted (id=%)', line_kind, old.id
      using errcode = 'restrict_violation';
  end if;

  if old.kind = 'time' then
    if new.hours is distinct from old.hours
       or new.rate_cents is distinct from old.rate_cents
       or new.resolved_rate_cents is distinct from old.resolved_rate_cents
       or new.activity_date is distinct from old.activity_date
       or new.billing_code_id is distinct from old.billing_code_id
       or new.matter_client_ids is distinct from old.matter_client_ids
       or new.billable is distinct from old.billable
       or new.matter_id is distinct from old.matter_id then
      raise exception 'this time entry is on an invoice: its hours, rate, date, charge code, client split, billable flag and matter are frozen (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
  elsif old.kind = 'flat_fee' then
    if new.charge_cents is distinct from old.charge_cents
       or new.activity_date is distinct from old.activity_date then
      raise exception 'this flat fee is on an invoice: its amount and date are frozen (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
  else
    if new.charge_cents is distinct from old.charge_cents
       or new.activity_date is distinct from old.activity_date
       or new.billable is distinct from old.billable then
      raise exception 'this expense is on an invoice: its amount, date and billable flag are frozen (id=%)', old.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return new;
end;
$$;
