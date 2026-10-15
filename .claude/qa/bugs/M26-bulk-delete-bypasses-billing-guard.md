# M26 — Bulk delete destroys invoices and trust history that single delete refuses to touch

- **Area / row:** Matters / M26 Close and delete a matter
- **Found:** 2026-07-27 (code audit, not browser)
- **Severity:** high (silent, irreversible financial data loss)
- **Status: FIXED.** `matters.service` checks `countBillingRecords` on the bulk path as well as
  the single one, and `tests/matters/bulkOperationsMixedScopeAndProtected.test.ts` asserts the
  same refusal message comes back for a matter with unbilled time in a mixed bulk selection.
  Kept as the record of what the defect was; the repro below no longer reproduces.

## Repro
1. Take a matter that has at least one invoice, time entry, expense, or trust transaction.
2. Open it and delete it from the matter detail page. It is correctly refused:
   "This matter has billing records ... Close or archive the matter instead."
3. Go to `/matters`, tick that same matter in the list, and use the bulk
   **Delete N matters** action.

## Expected
The same refusal. The matter's financial history is not deletable either way.

## Actual
The matter is deleted. Its invoices (with recorded payment history), time entries,
flat fees, expenses, and trust ledger entries are cascaded away by the database.
The UI reports success.

## Root cause
Two delete paths, one guard. `matters.service.deleteMatter` checked legal hold,
`trustTxnRepo.countByMatterId`, and `mattersRepo.countBillingRecords` before deleting.
`matters.service.bulkDelete` checked **only** legal hold. `countBillingRecords` and
`countByMatterId` each had exactly one caller, on the single-delete path.

The cascade is declared in `schema.sql`: `invoices`, `time_entries`, `flat_fees`,
`expenses` and the trust tables all carry
`foreign key (law_firm_id, matter_id) references matters ... on delete cascade`.

Reachable from two UI call sites: `MattersGrid.tsx` (matters list bulk action) and
`files/page.tsx` (matter-scoped file browser).

## Fix
Extracted the three checks into `assertMatterIsDeletable(lawFirmId, matterId, matterData)`
in `matters.service.js` and called it from **both** `deleteMatter` and `bulkDelete`, so the
paths cannot drift apart again. In the bulk path the thrown `ConflictError` is caught by
`runBulk` and recorded per item, so a refused matter lands in the response's `errors` map
instead of being deleted; the rest of the batch still goes through.

Bulk endpoints answer 200 even when items are refused, so the frontend was also reporting
a clean success for a partially-refused batch. Fixed alongside:
- `matters.service.ts` `deleteMultipleMatters` now returns `BulkResult`, not `{ message }`.
- `BulkResult` promoted from `services/tasks.service.ts` to `@/types` (it describes every
  bulk endpoint, not just tasks) and imported in both services.
- `MattersGrid.tsx` and `files/page.tsx` read `failed`/`errors` and report the real counts.
  The files page previously printed a hardcoded "N matter(s) deleted successfully".

**Verification:** `node --check` + module load on the backend; `tsc --noEmit` clean on the
frontend. NOT browser-verified — needs a matter with billing records and a bulk delete
against it, which is exactly what M26 should exercise. M26 stays `todo`.

## Related
Same bug class as the owner/admin visibility work: a guard added to the obvious path while
a parallel path keeps the old behaviour. Worth checking any future guard against every
route that reaches the same repository call.
