-- migration-mode: expand
--
-- A record of when a completed session's sealed artifacts were last re-read
-- from storage and checked against what the session row says they are.
--
-- Why this exists at all: production verification RESUMES the same saved hash
-- state that signing used. That makes finalizing a large document cheap, and it
-- means a defect in the resume path would be invisible to every check that
-- shares it. The same wrong answer computed twice agrees with itself.
--
-- The audit is the one reader that does not share the assumption. It streams
-- every byte of a sampled artifact back out of storage, recomputes the digest
-- from nothing, and verifies the signature over the range the document itself
-- declares. A mismatch is an alert, not a quiet retry: it means either the
-- stored bytes changed or this service computed the wrong digest, and both are
-- things a person has to look at.
--
-- One sampled artifact per drain, behind the same per-instance slot as signing,
-- so the check costs a bounded amount of a machine that is also serving
-- requests.

alter table signature_sessions add column if not exists audited_at    timestamptz;
alter table signature_sessions add column if not exists audit_result  text;
alter table signature_sessions add column if not exists audit_detail  text;

alter table signature_sessions drop constraint if exists signature_sessions_audit_result_check;
alter table signature_sessions add constraint signature_sessions_audit_result_check
  check (audit_result is null or audit_result in ('ok', 'mismatch', 'unreadable'));

create index if not exists signature_sessions_audit_idx
  on signature_sessions (audited_at nulls first, completed_at)
  where status = 'completed';
