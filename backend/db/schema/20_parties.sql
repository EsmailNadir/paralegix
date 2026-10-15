-- =====================================================================
-- PARTIES & CLIENTS
-- =====================================================================

-- =====================================================================
-- CLIENTS
-- =====================================================================

create table if not exists clients (
  id                       uuid not null default gen_random_uuid(),
  law_firm_id              uuid not null references law_firms(id) on delete cascade,
  user_id                  text references users(id) on delete set null,
  email                    citext,
  name                     text not null,
  phone                    text,
  organization             text,
  address                  text,
  preferred_contact_method text,
  status                   text not null default 'active'
    check (status in ('active', 'inactive', 'archived')),
  portal_invite_pending    boolean not null default false,
  invited_at               timestamptz,
  invited_by               text references users(id) on delete restrict,
  joined_at                timestamptz,
  stripe_customer_id       text,
  billing_rates            jsonb not null default '{}',
  settings                 jsonb not null default '{}',
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  invitation_sent_at       timestamptz,
  invitation_resend_count  integer not null default 0,
  invitation_failed        boolean not null default false,
  last_resend_at           timestamptz,
  -- person or company, immutable after insert (clients_type_immutable trigger
  -- below). A company is one clients row whose people are their own standalone
  -- person clients, joined to it through client_company_links (migration 0174,
  -- replacing the old contact_clients roster). It is not a synthetic user, and
  -- not a collection of personal clients.
  client_type              text not null default 'person' check (client_type in ('person', 'company')),
  -- Legal hold: when set, the record is preserved against destruction (a
  -- litigation hold blocks deletion). Enforced in the application delete paths.
  primary key (id),
  unique (law_firm_id, id),
  -- A company row must never carry clients.user_id directly. A company does not
  -- sign in; its linked person clients do, each holding their own user_id.
  constraint clients_company_no_user_id_check check (client_type <> 'company' or user_id is null)
);
create index if not exists clients_firm_email_idx on clients (law_firm_id, email) where email is not null;
create index if not exists clients_firm_type_idx on clients (law_firm_id, client_type);
-- Serves the on-delete walk of clients_user_id_fkey (migration 0224).
create index if not exists clients_user_id_idx on clients (user_id);

create or replace function clients_type_immutable() returns trigger as $$
begin
  if new.client_type is distinct from old.client_type then
    raise exception 'clients.client_type is immutable after insert (id=%)', old.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists clients_type_immutable on clients;
create trigger clients_type_immutable before update on clients
  for each row execute function clients_type_immutable();
create index if not exists clients_firm_name_idx on clients (law_firm_id, name);
create index if not exists clients_email_idx on clients (email);
-- Admin console list sorts, newest first, across every firm (migration 0132).
-- These are global rather than per-firm on purpose: the admin console reads
-- the whole table, so a law_firm_id-leading index cannot serve the sort.
create index if not exists clients_created_at_idx on clients (created_at desc);
-- Firm-scoped lower() expression indexes for the conflict-of-interest check and
-- the name-array client dedup lookup (lower(name|email|organization) = any(...)).
create index if not exists clients_firm_lower_name_idx on clients (law_firm_id, lower(name));
create index if not exists clients_firm_lower_email_idx on clients (law_firm_id, lower(email::text)) where email is not null;
create index if not exists clients_firm_lower_org_idx on clients (law_firm_id, lower(organization)) where organization is not null;

-- The people at a client (in-house counsel, an office manager, a spouse) are
-- rows in the firm-wide `contacts` directory linked here, NOT their own records:
-- an in-house counsel who is also co-counsel on a matter is one person, and used
-- to be two independently-editable copies. The table that held those copies
-- (`client_contacts`) was folded into the directory by migration 0136.
--
-- Defined further down, next to `contacts`, because it references it.


-- rather than holding their own copy, so a changed phone number is corrected in
-- one place and every matter that party touches is correct. (migration 0135)
--
-- Distinct from `clients` (which carries billing rates, a Stripe customer and a
-- portal login) and from `client_contacts` (the people at one client).
create table if not exists contacts (
  id            uuid not null default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  -- A company row (an insurance carrier, an expert firm) uses `name` for the
  -- organization and leaves `organization` null.
  contact_type  text not null default 'person'
                check (contact_type in ('person','company')),
  name          text not null,
  -- What this contact usually IS, independent of any one matter. The per-matter
  -- role lives on `matter_contacts.role` and may differ (an attorney who is
  -- opposing counsel on one matter can be co-counsel on another), so the two
  -- share a vocabulary but not a value.
  category      text not null default 'other'
                check (category in ('opposing_counsel','opposing_party','co_counsel','judge','witness',
                                    'expert','adjuster','court_clerk','mediator','guardian_ad_litem',
                                    'court_reporter','vendor','other')),
  organization  text,
  title         text,
  bar_number    text,
  email         citext,
  phone         text,
  phone_alt     text,
  fax           text,
  website       text,
  address       text,
  -- Judges and court clerks belong to a court. Single-column FK (not the
  -- composite tenant form) matching `matters.court_id`: a composite
  -- `on delete set null` would try to null `law_firm_id` too, which is not null.
  -- Tenant agreement is enforced in the service layer, as it is for matters.
  court_id      uuid,
  notes         text,
  tags          text[] not null default '{}',
  is_archived   boolean not null default false,
  -- Scoped to the single matter it was created for. Excluded from the
  -- directory list and every contact picker unless explicitly asked for.
  one_time      boolean not null default false,
  created_by    text references users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  foreign key (court_id) references courts (id) on delete set null
);
create index if not exists contacts_firm_name_idx on contacts (law_firm_id, name);
create index if not exists contacts_firm_category_idx on contacts (law_firm_id, category);
create index if not exists contacts_firm_court_idx on contacts (law_firm_id, court_id) where court_id is not null;
-- Firm-scoped lower() expression indexes, mirroring `clients`: these back the
-- duplicate-on-create lookup and the conflict-of-interest check, both of which
-- match case-insensitively on name / email / organization.
create index if not exists contacts_firm_lower_name_idx on contacts (law_firm_id, lower(name));
create index if not exists contacts_firm_lower_email_idx on contacts (law_firm_id, lower(email::text)) where email is not null;
create index if not exists contacts_firm_lower_org_idx on contacts (law_firm_id, lower(organization)) where organization is not null;
-- Deliberately NO unique constraint on (firm, name) or (firm, email): two real
-- people share a name, and one person legitimately appears under a personal and
-- a work address. Duplicates are a soft warning at create time (the service
-- returns near-matches so the UI can offer to link the existing contact), which
-- a hard constraint would turn into a dead end.

-- The people at a client. This is what `client_contacts` used to be, except the
-- person is a directory row, so the same in-house counsel who is also co-counsel
-- on a matter is one record rather than two. (migration 0136)


create table if not exists contact_clients (
  id            uuid not null default gen_random_uuid(),
  law_firm_id   uuid not null references law_firms(id) on delete cascade,
  contact_id    uuid not null,
  client_id     uuid not null,
  -- How this person relates to that client ("General Counsel", "Spouse"). Free
  -- text, as it was on client_contacts: firms describe these relationships in
  -- their own words and an enum would not survive contact with reality.
  relationship  text,
  is_primary    boolean not null default false,
  created_by    text references users(id) on delete restrict,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Delivery and access preferences for this contact on this client. The
  -- portal identity columns that used to sit here (user_id and the four portal
  -- lifecycle fields) went with migration 0261: a company's people are ordinary
  -- Person clients linked by client_company_links, so the identity lives on
  -- their own clients row.
  is_email_recipient     boolean not null default false,
  can_view_billing       boolean not null default false,
  primary key (id),
  unique (law_firm_id, id),
  constraint contact_clients_unique_link unique (law_firm_id, contact_id, client_id),
  foreign key (law_firm_id, contact_id) references contacts (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, client_id) references clients (law_firm_id, id) on delete cascade
);
create index if not exists contact_clients_client_idx on contact_clients (law_firm_id, client_id);
-- One primary contact per client, enforced here rather than by hand in the
-- service, so a concurrent pair of writes cannot leave a client with two.
create unique index if not exists contact_clients_one_primary_idx
  on contact_clients (law_firm_id, client_id) where is_primary;
-- Billing-recipient fan-out (invoice delivery).
create index if not exists contact_clients_email_recipient_idx
  on contact_clients (law_firm_id, client_id) where is_email_recipient;

-- Real client-to-client company relationships (migration 0174), replacing
-- contact_clients as the way a company client's people are modeled: a
-- linked person is a real client_type='person' clients row (its own matters,
-- billing, and portal identity), not a lightweight contacts-directory entry.
-- The service layer enforces person_client_id/company_client_id's client_type
-- before insert; Postgres cannot express that as a cross-row CHECK.
--
-- No portal identity columns: a linked person carries all of that on their own
-- clients row. contact_clients had a mirror set for the design this replaced,
-- and migration 0261 dropped them there too. relationship/is_primary/
-- is_email_recipient/can_view_billing mirror contact_clients's columns of the
-- same name and same semantics unchanged.
create table if not exists client_company_links (
  id                    uuid not null default gen_random_uuid(),
  law_firm_id           uuid not null references law_firms(id) on delete cascade,
  person_client_id      uuid not null,
  company_client_id     uuid not null,
  relationship          text,
  is_primary            boolean not null default false,
  is_email_recipient    boolean not null default false,
  can_view_billing      boolean not null default false,
  created_by            text references users(id) on delete restrict,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  primary key (id),
  unique (law_firm_id, id),
  constraint client_company_links_unique unique (law_firm_id, person_client_id, company_client_id),
  constraint client_company_links_not_self check (person_client_id <> company_client_id),
  foreign key (law_firm_id, person_client_id) references clients (law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, company_client_id) references clients (law_firm_id, id) on delete cascade
);
-- One primary person per company, enforced here rather than by hand in the
-- service, so a concurrent pair of writes cannot leave a company with two.
create unique index if not exists client_company_links_one_primary_idx
  on client_company_links (law_firm_id, company_client_id) where is_primary;
-- A company's people (roster listing, billing/messaging/signature fan-out).
create index if not exists client_company_links_company_idx
  on client_company_links (law_firm_id, company_client_id);
-- client_company_links_person_idx removed by migration 0195: client_company_links_unique
-- (law_firm_id, person_client_id, company_client_id) covers the same rows.
-- Client-email fan-out for company-linked people.
create index if not exists client_company_links_email_recipient_idx
  on client_company_links (law_firm_id, company_client_id) where is_email_recipient;

-- The central association resolver's company arm becomes a clients.user_id
-- lookup instead of contact_clients.user_id (which had its own partial
-- indexes, dropped with the column by migration 0261). clients had no
-- user_id index at all before this migration - the person arm apparently got
-- away without one at current scale, but consolidating the company arm's
-- traffic onto the same unindexed column would make an already-hot lookup
-- path measurably slower, so add the equivalent partial index here.
create index if not exists clients_firm_user_idx
  on clients (law_firm_id, user_id) where user_id is not null;

-- Client identity verification through Credence ID (migration 0049). A row keeps
-- the credential's name, issuer, document type, expiry and check results, and
-- never the portrait, signature, license number, address or birth date.
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
comment on table client_identity_verifications is 'One identity verification attempt by a portal client through Credence ID. Keeps the verified name, issuer, document type, expiry and check results only; never the portrait, signature, license number, address or birth date.';


-- Column comments. These were written by earlier migrations and never carried
-- into the domain files, so a database built from schema.sql lacked them while
-- a migrated one had them. They are the reference for what each column means.
comment on column client_company_links.is_email_recipient is 'Whether this linked person receives client-facing email communications.';
comment on column clients.client_type is 'person or company, immutable after insert (see the clients_type_immutable trigger). A company is one clients row whose people are Person clients joined by client_company_links, not a synthetic user or a collection of personal clients.';
comment on column contact_clients.can_view_billing is 'A preference on a person client''s own contact roster, shown and edited in the client screen. It authorizes nothing: the portal billing gate is client_company_links.can_view_billing, which is a different table and a different relationship.';
comment on column contact_clients.is_email_recipient is 'Whether this linked contact receives client-facing email communications.';
comment on column contacts.one_time is 'Scoped to the single matter it was created for. Excluded from the directory list and every contact picker unless explicitly asked for. Flip to false ("promote") to make it a normal reusable directory contact.';
