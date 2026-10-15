-- migration-mode: expand
--
-- Key a signing field by its session, not globally.
--
-- Pre-condition: `signature_fields` has `primary key (id)` and
-- `unique (law_firm_id, id)`. A field id is the client's name for the field
-- (the placer copies it from a saved signing template), so the second session
-- sent from one template, in any firm, failed on `signature_fields_pkey`.
-- No foreign key references `signature_fields`, and no statement upserts on
-- either key.
--
-- Post-condition: `primary key (session_id, id)`; `unique (law_firm_id, id)`
-- and `signature_fields_session_id_idx` are gone. The tenant boundary is the
-- existing composite foreign key `(law_firm_id, session_id)` to the session.
-- The single-column index on `session_id` is a strict prefix of the new
-- primary key, which now covers the `session_id` foreign key and the
-- per-session field read.
--
-- Expand: it only relaxes uniqueness. Every existing row already satisfies the
-- new key (ids were globally unique), and the deployed code neither relies on
-- nor conflicts on the dropped keys.

alter table signature_fields drop constraint if exists signature_fields_pkey;
alter table signature_fields add constraint signature_fields_pkey primary key (session_id, id);
alter table signature_fields drop constraint if exists signature_fields_law_firm_id_id_key;
drop index if exists signature_fields_session_id_idx;
