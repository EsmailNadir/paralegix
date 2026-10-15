-- migration-mode: expand
--
-- A role that can manage something also holds the reads that go with it. The
-- member baseline holds no financial reads, so a role with
-- billing.manageTimeEntries but without billing.viewRates reaches the time
-- entry form and gets a 403 on the charge-code picker. The roles repository
-- adds the implied reads on every write (MANAGE_IMPLIES_VIEW in
-- src/modules/lawfirms/roles/permissions.ts); this migration applies the same
-- rule to the roles that already exist.
--
-- Pre:  roles.permissions (text[]) may hold a manage code without the reads it
--       implies.
-- Post: every role, built-in or custom, that holds a manage code listed below
--       also holds each read listed with it, appended after the codes the role
--       already had, in the order listed. Roles holding no listed manage code
--       are untouched, no permission is removed, and a second run changes
--       nothing. One statement per manage code, in the order of
--       MANAGE_IMPLIES_VIEW; tests/permissions/manageImpliesViewBackfill.test.ts
--       fails if the two disagree.

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['billing.viewTimeEntries', 'billing.viewRates']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'billing.manageTimeEntries' = any(permissions)
   and not (array['billing.viewTimeEntries', 'billing.viewRates'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['billing.viewInvoices', 'billing.viewRates']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'billing.manageInvoices' = any(permissions)
   and not (array['billing.viewInvoices', 'billing.viewRates'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['billing.viewInvoices']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'billing.recordPayments' = any(permissions)
   and not (array['billing.viewInvoices'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['billing.viewRates']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'billing.manageRates' = any(permissions)
   and not (array['billing.viewRates'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['billing.viewPlans']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'billing.managePlans' = any(permissions)
   and not (array['billing.viewPlans'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['billing.viewExpenses']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'billing.manageExpenses' = any(permissions)
   and not (array['billing.viewExpenses'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['trust.view']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'trust.manage' = any(permissions)
   and not (array['trust.view'] <@ permissions);

update roles
   set permissions = permissions || array(
         select v
           from unnest(array['trust.view']) with ordinality as implied(v, position)
          where not (v = any(roles.permissions))
          order by position
       ),
       updated_at = now()
 where 'trust.reconcile' = any(permissions)
   and not (array['trust.view'] <@ permissions);
