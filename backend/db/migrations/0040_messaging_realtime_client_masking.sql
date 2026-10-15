-- migration-mode: contract
-- Narrows what a client's Realtime (authenticated) connection may read. It
-- removes access the deployed portal uses: the portal's direct-thread
-- postgres_changes subscription on `messages` stops delivering. Deploy the
-- portal that watches the conversations row instead before applying this.
--
-- Pre:  messaging_realtime_message_access lets the client_id owner of a DIRECT
--       conversation select its messages rows (sender_name/sender_user_id of a
--       send-as-firm message, retained content of a soft-deleted one), and
--       conversation_participants_select lets any client participant of a group
--       select every participant row (lawyers' last_read_at, co-clients'
--       history_visible_from, pending recipients' client_id).
-- Post: messages rows are selectable only by firm members (an active
--       participant for a group, any member of the firm for a direct thread);
--       a client selects only its own conversation_participants row, while a
--       firm member with access still sees the whole roster. The conversations
--       policy is unchanged, so a client can still watch its own thread rows.

create or replace function public.messaging_realtime_message_access(p_conversation uuid, p_uid text)
returns boolean language sql security definer stable set search_path = public, pg_catalog as $$
  select exists (
    select 1 from conversations c
     where c.id = p_conversation
       and exists (select 1 from members m
                    where m.law_firm_id = c.law_firm_id and m.user_id = p_uid)
       and (c.conversation_type <> 'group'
            or exists (select 1 from conversation_participants cp
                        where cp.conversation_id = c.id
                          and cp.participant_user_id = p_uid
                          and cp.removed_at is null))
  )
$$;
revoke all on function public.messaging_realtime_message_access(uuid, text) from public;
grant execute on function public.messaging_realtime_message_access(uuid, text) to authenticated;

drop policy if exists conversation_participants_select on conversation_participants;
create policy conversation_participants_select on conversation_participants for select using (
  public.messaging_can_access_conversation(conversation_id, auth.jwt() ->> 'sub')
  and (participant_user_id = (auth.jwt() ->> 'sub')
       or public.rls_is_firm_member(law_firm_id, auth.jwt() ->> 'sub'))
);
