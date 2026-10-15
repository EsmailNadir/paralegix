/**
 * `isTimeEntryLocked`: whether a listed time entry may still be edited or
 * deleted.
 *
 * The backend refuses an edit to the billed fields, and refuses a delete
 * outright, only for an entry a line item on a non-voided invoice names
 * (`billingReads.isSourceBilled`, enforced again by the
 * `activities_billed_immutable` trigger). The firm list reports that as
 * `billingStatus: 'billed'`. `queued` (picked up by a pending invoice run) and
 * `covered_by_retainer` (paid for by a retainer period's included hours) are
 * NOT on an invoice, so the server lets them change.
 *
 * Red if the lock is wider than the server's (queued or covered time shown as
 * read-only, and skipped by bulk delete) or narrower (billed time offered an
 * edit the server refuses).
 */
import { isTimeEntryLocked } from '@/components/billingComp/utils';

describe('isTimeEntryLocked', () => {
  it('locks an entry that is on an invoice', () => {
    expect(isTimeEntryLocked({ billingStatus: 'billed' })).toBe(true);
  });

  it.each(['unbilled', 'queued', 'covered_by_retainer'])('leaves a %s entry editable', (billingStatus) => {
    expect(isTimeEntryLocked({ billingStatus })).toBe(false);
  });

  it('leaves an entry with no billing status editable', () => {
    expect(isTimeEntryLocked({})).toBe(false);
    expect(isTimeEntryLocked({ billingStatus: null })).toBe(false);
  });
});
