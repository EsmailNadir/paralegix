/**
 * Who an invoice is billed to, and where the firm is paid.
 *
 * `getInvoiceBillTo` is the single place the PDF, the client portal invoice page
 * and the firm's invoice sidebar all resolve the bill-to party, so a mistake
 * here is wrong in three places at once and on a document a client keeps.
 *
 * Its central rule is the one organization work keeps breaking: ONCE ISSUED, an
 * invoice is frozen. Renaming an organization, or moving someone off its roster,
 * must not reshape an invoice sent months earlier. Nothing tested that.
 *
 * `parseRemitTo` is here for the same reason: its doc comment records a real bug
 * where a jsonb column arriving as a JSON *string* printed raw braces onto an
 * invoice PDF, and the fix had no test.
 */
import { getInvoiceBillTo, parseRemitTo } from '@/components/billingComp/utils';
import type { Invoice } from '@/types';

/** An invoice that has issued, so its billing snapshot is authoritative. */
function issued(overrides: Record<string, unknown> = {}) {
  return {
    billingSnapshotAt: '2026-03-01T00:00:00.000Z',
    billingClientName: 'Acme Corporation',
    billingContactName: 'Bea Billing',
    billingContactTitle: 'Controller',
    billingContactEmail: 'bea@acme.test',
    billingClientAddress: '1 Acme Way',
    billingEmails: ['bea@acme.test', 'ap@acme.test'],
    clientName: 'Stale Legacy Name',
    ...overrides,
  } as unknown as Invoice;
}

/** A draft invoice, which has frozen nothing yet. */
function draft(overrides: Record<string, unknown> = {}) {
  return { billingSnapshotAt: null, ...overrides } as unknown as Invoice;
}

describe('an ISSUED invoice is frozen', () => {
  it('uses the snapshot name, not the live client record', () => {
    const billTo = getInvoiceBillTo(issued(), {
      name: 'Acme Corporation LLC (renamed last week)',
      clientType: 'company',
      email: 'new@acme.test',
      address: '99 New Street',
    });

    // The whole point. A March invoice shows what it showed in March, whatever
    // the organization is called today. Reading the live record here rewrites
    // history on a document the client already has a copy of.
    expect(billTo.name).toBe('Acme Corporation');
    expect(billTo.address).toBe('1 Acme Way');
    expect(billTo.source).toBe('snapshot');
  });

  it('ignores a live client entirely, even for the email', () => {
    const billTo = getInvoiceBillTo(issued(), { email: 'somebody-else@acme.test' });

    // Where a paid invoice's receipt goes must match where the invoice went.
    expect(billTo.primaryEmail).toBe('bea@acme.test');
    expect(billTo.emails).toEqual(['bea@acme.test', 'ap@acme.test']);
  });

  it('builds the attention line from the frozen contact', () => {
    const billTo = getInvoiceBillTo(issued());

    // An organization does not open post; a named person does. This is the line
    // that gets the invoice to a desk.
    expect(billTo.attentionLine).toBe('Attn: Bea Billing, Controller');
  });

  it('omits the title when the frozen contact had none', () => {
    const billTo = getInvoiceBillTo(issued({ billingContactTitle: null }));

    // Not "Attn: Bea Billing, ", which is what naive concatenation prints onto
    // the PDF.
    expect(billTo.attentionLine).toBe('Attn: Bea Billing');
  });

  it('has no attention line when nothing was frozen', () => {
    const billTo = getInvoiceBillTo(issued({ billingContactName: null }));

    expect(billTo.attentionLine).toBeNull();
  });

  it('reports no name when the snapshot froze none', () => {
    const billTo = getInvoiceBillTo(issued({ billingClientName: null }));

    // `billingClientName` is the frozen value. The draft-time `clientName` can
    // disagree with it, so a snapshot must never fall back to that copy.
    expect(billTo.name).toBeNull();
  });

  it('reports isCompany TRUE when an attention contact was frozen', () => {
    // The backend writes an attention contact for organizations alone, so its
    // presence is the only signal a snapshot carries.
    expect(getInvoiceBillTo(issued()).isCompany).toBe(true);
  });

  it('reports isCompany NULL, not false, when no contact was frozen', () => {
    const billTo = getInvoiceBillTo(issued({ billingContactName: null }));

    // "Cannot tell", not "is a person". An organization whose roster had no
    // usable contact lands here, and rendering it as a person would drop the
    // organization framing off its own invoice.
    expect(billTo.isCompany).toBeNull();
  });

  it('falls back to the first billing email when no contact email was frozen', () => {
    const billTo = getInvoiceBillTo(issued({ billingContactEmail: null }));

    expect(billTo.primaryEmail).toBe('bea@acme.test');
  });

  it('never carries a free-text employer on a snapshot', () => {
    const billTo = getInvoiceBillTo(issued(), { organization: 'Some Employer' });

    // `organization` is a PERSON client's free-text employer field. Leaking it
    // onto an organization's own invoice prints an employer under a company
    // that has none.
    expect(billTo.organization).toBeNull();
  });
});

describe('a DRAFT invoice reads live data', () => {
  it('uses the live client name when the invoice has none', () => {
    const billTo = getInvoiceBillTo(draft(), { name: 'Live Client' });

    // Before first issue there is nothing frozen, so a rename SHOULD show. The
    // mirror image of the snapshot rule above.
    expect(billTo.name).toBe('Live Client');
    expect(billTo.source).toBe('draft');
  });

  it('prefers the invoice clientName over the live record', () => {
    const billTo = getInvoiceBillTo(draft({ clientName: 'On The Invoice' }), { name: 'Live Client' });

    expect(billTo.name).toBe('On The Invoice');
  });

  it('carries a person client free-text employer', () => {
    const billTo = getInvoiceBillTo(draft(), {
      name: 'Pat Person',
      clientType: 'person',
      organization: 'Pat Employer Inc',
    });

    // The legitimate use of the field: an employer printed under a person's
    // name, which is not the same thing as billing an organization.
    expect(billTo.organization).toBe('Pat Employer Inc');
    expect(billTo.isCompany).toBe(false);
  });

  it('reports isCompany true for a live company client', () => {
    expect(getInvoiceBillTo(draft(), { clientType: 'company' }).isCompany).toBe(true);
  });

  it('reports isCompany NULL when no client record is loaded', () => {
    // A caller that did not load the client cannot answer the question, and
    // guessing "person" would silently mis-frame an organization's draft.
    expect(getInvoiceBillTo(draft()).isCompany).toBeNull();
  });

  it('prefers the invoice billingEmail over the live client email', () => {
    const billTo = getInvoiceBillTo(draft({ billingEmail: 'override@acme.test' }), {
      email: 'client@acme.test',
    });

    // An explicitly set billing email is a deliberate override.
    expect(billTo.primaryEmail).toBe('override@acme.test');
    expect(billTo.emails).toEqual(['override@acme.test']);
  });

  it('returns an EMPTY email list rather than a list holding null', () => {
    const billTo = getInvoiceBillTo(draft());

    // A `[null]` here renders a blank recipient row and, worse, counts as one
    // recipient when the code asks how many addresses this bill reaches.
    expect(billTo.emails).toEqual([]);
    expect(billTo.primaryEmail).toBeNull();
  });
});

describe('parseRemitTo', () => {
  it('takes an ordinary object', () => {
    expect(parseRemitTo({ name: 'Firm LLP', city: 'Austin' }))
      .toEqual({ name: 'Firm LLP', city: 'Austin' });
  });

  it('parses a jsonb column that arrived as a JSON STRING', () => {
    // The documented bug. Some rows come back as a string, and a caller that
    // only handled objects printed the raw braces onto the invoice PDF.
    expect(parseRemitTo('{"name":"Firm LLP","address":"1 Main St"}'))
      .toEqual({ name: 'Firm LLP', address: '1 Main St' });
  });

  it('treats a plain string as the firm name', () => {
    expect(parseRemitTo('Firm LLP')).toEqual({ name: 'Firm LLP' });
  });

  it('treats MALFORMED json as a plain name rather than throwing', () => {
    // A throw here takes down the whole PDF render over one bad column.
    expect(parseRemitTo('{not valid json')).toEqual({ name: '{not valid json' });
  });

  it('returns null for an object with nothing in it', () => {
    // Distinct from an object with a name: null means "render no remit-to
    // block", while an empty object renders an empty box on the invoice.
    expect(parseRemitTo({})).toBeNull();
    expect(parseRemitTo({ name: '', address: '', city: '', state: '', zip: '' })).toBeNull();
  });

  it('returns null for empty and whitespace-only input', () => {
    expect(parseRemitTo(null)).toBeNull();
    expect(parseRemitTo(undefined)).toBeNull();
    expect(parseRemitTo('')).toBeNull();
    expect(parseRemitTo('   ')).toBeNull();
  });

  it('returns null for a type it cannot use', () => {
    expect(parseRemitTo(42)).toBeNull();
    expect(parseRemitTo(true)).toBeNull();
  });

  it('keeps an object that carries only a zip', () => {
    // Any one usable field is enough to render. Requiring a name would drop a
    // partially filled remit-to block off the invoice entirely.
    expect(parseRemitTo({ zip: '78701' })).toEqual({ zip: '78701' });
  });
});
