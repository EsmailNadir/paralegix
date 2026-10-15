-- migration-mode: expand
--
-- The built-in Paralegal role now carries billing.viewPlans. Paralegals log
-- time against retainer matters and need to see the plans those matters sit on.
-- billing.viewPlans is not in the member baseline, so a built-in Paralegal role
-- seeded before this code was added would 403 on GET /billing/plans.
--
-- Pre:  built-in Paralegal roles (is_built_in = true, name = 'Paralegal') may
--       lack billing.viewPlans in roles.permissions (text[]).
-- Post: every built-in Paralegal role holds billing.viewPlans exactly once.
--       Custom roles, including one a firm named "Paralegal", and every other
--       built-in role are untouched. A second run changes nothing.

update roles
   set permissions = array_append(permissions, 'billing.viewPlans'),
       updated_at = now()
 where is_built_in = true
   and name = 'Paralegal'
   and not ('billing.viewPlans' = any(permissions));
