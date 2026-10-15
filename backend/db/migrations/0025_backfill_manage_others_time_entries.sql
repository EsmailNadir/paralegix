-- migration-mode: expand
--
-- Editing, moving and deleting another member's time entries, and logging time
-- in their name, now needs billing.manageOthersTimeEntries on top of
-- billing.manageTimeEntries.
--
-- Pre:  roles.permissions (text[]) holds billing.manageTimeEntries on every
--       role that may keep time, and the new code on none.
-- Post: every role that holds billing.manageTimeEntries also holds
--       billing.manageOthersTimeEntries, so no existing firm changes behaviour.
--       A firm opts into "own entries only" by removing the code from a role.
--       Roles without billing.manageTimeEntries are untouched, and a second
--       run changes nothing.

update roles
   set permissions = array_append(permissions, 'billing.manageOthersTimeEntries')
 where 'billing.manageTimeEntries' = any(permissions)
   and not ('billing.manageOthersTimeEntries' = any(permissions));
