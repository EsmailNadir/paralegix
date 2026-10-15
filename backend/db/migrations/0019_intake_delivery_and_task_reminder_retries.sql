-- migration-mode: expand
-- Precondition: intake send state is implicit and task reminder claims are task-wide.
-- Postcondition: intake delivery has an explicit outcome, and task recipients have
-- independent expiring claims and successful-send timestamps. Existing code remains compatible.

alter table intake_submissions add column delivery_status text not null default 'sent'
  check (delivery_status in ('pending', 'sent', 'failed'));

create table task_reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  task_id uuid not null,
  recipient_key text not null,
  last_sent_at timestamptz,
  sent_count int not null default 0 check (sent_count >= 0),
  claim_token uuid,
  claim_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (law_firm_id, id),
  unique (law_firm_id, task_id, recipient_key),
  foreign key (law_firm_id, task_id) references tasks(law_firm_id, id) on delete cascade,
  check ((claim_token is null) = (claim_expires_at is null))
);
create trigger set_updated_at before update on task_reminder_deliveries
  for each row execute function set_updated_at();
