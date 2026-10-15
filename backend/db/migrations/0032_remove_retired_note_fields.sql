-- migration-mode: contract
-- Precondition: firm notes are internal and all note-linked time is in activities.
-- Postcondition: notes have no retired portal visibility or embedded activity fields.
-- Apply only after deploying the code that removes the portal-note reader.

alter table notes
  drop column client_visible,
  drop column activity_name,
  drop column activity_description,
  drop column is_billable;
