-- migration-mode: expand
-- Precondition: upload receipts have single-column indexes for their composite file and reservation foreign keys.
-- Postcondition: both composite foreign keys have leading indexes, and receipt updates refresh updated_at.
create index if not exists document_request_uploads_firm_file_idx on document_request_uploads (law_firm_id, file_id);
create index if not exists document_request_uploads_firm_reservation_idx on document_request_uploads (law_firm_id, reservation_id);
create trigger set_updated_at before update on document_request_uploads for each row execute function set_updated_at();
