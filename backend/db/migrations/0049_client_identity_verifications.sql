-- migration-mode: expand
-- Client identity verification through Credence ID. A portal client presents
-- the driver's license in their phone wallet; the provider checks it and this
-- table keeps the outcome against the firm's client record.
--
-- Data minimization is the design: a row keeps the name on the credential, the
-- issuing jurisdiction, the document type, the credential's expiry and the
-- result of each check. The portrait, signature image, license number, address
-- and birth date are never stored, so there is no column for them.
--
-- Pre:  no table named client_identity_verifications.
-- Post: client_identity_verifications exists, empty, firm-scoped with
--       unique (law_firm_id, id); each row belongs to one client through the
--       composite (law_firm_id, client_id) key and to the portal user who
--       started it. Old code never reads it.

create table if not exists client_identity_verifications (
  id                     uuid not null default gen_random_uuid(),
  law_firm_id            uuid not null references law_firms(id) on delete cascade,
  client_id              uuid not null,
  -- The portal user who started the attempt. Only they may complete or poll it.
  user_id                text not null references users(id) on delete restrict,
  method                 text not null
    check (method in ('mdoc_dcapi', 'openid4vp_dcapi', 'w3c_openid4vp')),
  status                 text not null default 'pending'
    check (status in ('pending', 'verified', 'failed', 'cancelled', 'expired')),
  -- The provider's session handle. Never sent to the browser.
  provider_session_id    text not null,
  -- The name as the credential states it, which is the record of what was
  -- verified, not a copy of the client's name.
  verified_given_name    text,
  verified_family_name   text,
  -- Issuing jurisdiction, e.g. "California" or "US-CA".
  issuer                 text,
  -- The provider's document type, e.g. "org.iso.18013.5.1.mDL". Open vocabulary.
  doc_type               text,
  credential_expires_on  date,
  -- Whether the credential's name matches the client record. A flag, not a gate:
  -- a differing name is still verified.
  is_name_match          boolean,
  -- Pass or fail of each provider check, keyed by check name.
  checks                 jsonb not null default '{}',
  failure_reason         text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz,
  expires_at             timestamptz not null default (now() + interval '10 minutes'),
  primary key (id),
  unique (law_firm_id, id),
  constraint client_identity_verifications_provider_session_key unique (provider_session_id),
  constraint client_identity_verifications_client_fkey
    foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade,
  -- A finished attempt says when it finished.
  constraint client_identity_verifications_completed_check
    check (status = 'pending' or completed_at is not null)
);

-- The firm's client record reads the latest attempt and the latest verified
-- one; this also serves the composite foreign key's cascade.
create index if not exists client_identity_verifications_client_idx
  on client_identity_verifications (law_firm_id, client_id, created_at desc);
-- Serves the on-delete walk of the users foreign key.
create index if not exists client_identity_verifications_user_idx
  on client_identity_verifications (user_id);

drop trigger if exists set_updated_at on client_identity_verifications;
create trigger set_updated_at before update on client_identity_verifications
  for each row execute function set_updated_at();

comment on table client_identity_verifications is 'One identity verification attempt by a portal client through Credence ID. Keeps the verified name, issuer, document type, expiry and check results only; never the portrait, signature, license number, address or birth date.';
