-- migration-mode: contract
--
-- Two columns that hold a copy of something the read path already has.
--
-- `messages.recipient_id` is written on every send as
-- `senderType === 'client' ? lawFirmId : clientId`, which is to say "the other
-- side of this thread". It is derivable from the conversation, it is meaningless
-- for a group thread with many recipients, and nothing reads it for a decision:
-- the repository maps it into the entity, the frontend carries it in a type, and
-- there it stops.
--
-- `conversations.last_message_preview` is the first 100 characters of the newest
-- message. Every conversation read already joins that message and coalesces the
-- stored copy over the join, which is the same shape migration 0251 removed for
-- `conversations.client_name`, `client_email` and `law_firm_name`. The copy is
-- written once at send time and never updated, so an edited or deleted message
-- left the list showing text the thread no longer contains.
--
-- `messages.sender_name` is deliberately NOT dropped with them. It looks like the
-- same kind of copy and is not: it is one firm's record of who spoke, erasable
-- per firm by `anonymizeParticipantIdentity`, for a person who may still be a
-- live client of another firm. A join to `users.name` has one value globally and
-- cannot express that.

alter table messages       drop column if exists recipient_id;
alter table conversations  drop column if exists last_message_preview;
