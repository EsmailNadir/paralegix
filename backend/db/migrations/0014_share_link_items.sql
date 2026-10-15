-- migration-mode: expand
--
-- A share link may name several files and folders at once.
--
-- Pre:  every file_share_links row points at one document through file_id.
-- Post: file_share_link_items exists. A link with rows there is a multi-item
--       link and carries a null file_id; a link without rows is the original
--       single-file shape and is unchanged. No existing row is rewritten.

-- The composite key the items point at, so an item cannot name a link in
-- another firm. The token is already the primary key, so every existing row
-- satisfies this.
alter table file_share_links
  add constraint file_share_links_law_firm_id_token_key unique (law_firm_id, token);

-- One row per item a multi-item link names. Written once with the link and
-- never updated: revoking acts on the link, and a deleted item drops out of
-- what the link resolves to at read time.
create table if not exists file_share_link_items (
  law_firm_id uuid not null references law_firms(id) on delete cascade,
  token       text not null,
  file_id     uuid not null,
  created_at  timestamptz not null default now(),
  primary key (law_firm_id, token, file_id),
  foreign key (law_firm_id, token) references file_share_links (law_firm_id, token) on delete cascade,
  foreign key (law_firm_id, file_id) references files (law_firm_id, id) on delete cascade
);
create index if not exists file_share_link_items_file_idx
  on file_share_link_items (law_firm_id, file_id);
