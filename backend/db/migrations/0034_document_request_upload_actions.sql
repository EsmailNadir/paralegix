-- migration-mode: expand
-- Precondition: an upload-init retry creates a fresh file and quota reservation.
-- Postcondition: the same client action can recover its original sessions and files.
create table if not exists document_request_uploads (
  id uuid primary key default gen_random_uuid(),
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  item_id uuid not null,
  created_by text not null references users(id) on delete restrict,
  action_key uuid not null,
  position integer not null check (position >= 0),
  request_hash text not null,
  file_id uuid not null,
  upload_url text not null,
  reservation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (law_firm_id, id),
  unique (law_firm_id, item_id, created_by, action_key, position),
  foreign key (law_firm_id, item_id) references document_request_items(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, file_id) references files(law_firm_id, id) on delete cascade,
  foreign key (law_firm_id, reservation_id) references storage_reservations(law_firm_id, id) on delete set null (reservation_id)
);
create index if not exists document_request_uploads_item_idx on document_request_uploads (item_id);
create index if not exists document_request_uploads_creator_idx on document_request_uploads (created_by);
create index if not exists document_request_uploads_file_idx on document_request_uploads (file_id);
create index if not exists document_request_uploads_reservation_idx on document_request_uploads (reservation_id);
