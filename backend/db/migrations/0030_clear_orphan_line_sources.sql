-- migration-mode: expand
--
-- An invoice line that names a source (time_entry, expense or flat_fee with a
-- source_id) must name a real activity of the same firm and kind: that link is
-- what freezes the activity and takes it off the unbilled lists. A line with no
-- source_id is a manual line, billed as typed, that no activity trigger touches.
-- Lines written before the API enforced this can carry a source_id that names no
-- activity, so they look sourced and protect nothing.
--
-- Pre:  invoice_line_items rows of kind time_entry, expense or flat_fee may hold
--       a source_id (text) that matches no activities row of the same firm and
--       kind.
-- Post: every such row has source_id = null and so reads as a manual line. Rows
--       whose source_id names a real activity of the same firm and kind, rows
--       that already have no source_id, and recurring plan fee lines (a flat_fee
--       whose source_id is plan-<planId>-<periodStartDate>, which names a plan
--       period rather than an activity) are untouched. Amounts and every other
--       column are unchanged. A second run changes nothing.

update invoice_line_items li
   set source_id = null
 where li.kind in ('time_entry', 'expense', 'flat_fee')
   and li.source_id is not null
   and not (li.kind = 'flat_fee'
            and li.source_id ~* '^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[0-9]{4}-[0-9]{2}-[0-9]{2}$')
   and not exists (
         select 1
           from activities a
          where a.law_firm_id = li.law_firm_id
            and a.kind = case li.kind when 'time_entry' then 'time' else li.kind end
            and a.id::text = li.source_id
       );
