-- migration-mode: contract
-- Precondition: no queued work uses the retired notification kind.
-- Postcondition: only kinds with a writer and retry sweep are accepted.
-- Existing queued work is never rewritten or deleted. The deployed writers
-- enqueue inbound work as webhook, and no writer uses notification.
do $$
begin
  lock table calendar_sync_failures in access exclusive mode;
  if exists (select 1 from calendar_sync_failures where kind = 'notification') then
    raise exception 'Cannot retire notification calendar work while queued rows remain';
  end if;
  alter table calendar_sync_failures drop constraint calendar_sync_failures_kind_check;
  alter table calendar_sync_failures add constraint calendar_sync_failures_kind_check
    check (kind in ('webhook', 'stop_channel', 'outbound'));
end
$$;
