import { generateLedesExport } from '../../src/modules/billing/invoices/ledesExport.service';

describe('LEDES 1998B Export Service', () => {
  const baseLawFirm = {
    id: 'firm-uuid-1',
    name: 'Acme Law Firm',
  };

  const baseClient = {
    id: 'client-uuid-1',
    name: 'Globex Corp',
  };

  it('generates a valid LEDES 1998B format with header and columns', () => {
    const invoice = {
      id: 'inv-1',
      invoiceName: 'INV-2026-001',
      invoiceDate: '2026-08-15',
      totalAmount: 1500.0,
      notes: 'Monthly billing for corporate counsel',
      timeEntries: [
        {
          id: 'te-1',
          date: '2026-08-10',
          hours: 3.5,
          rate: 300.0,
          amount: 1050.0,
          utbmsTaskCode: 'L110',
          utbmsActivityCode: 'A101',
          userId: 'usr-1',
          userName: 'Jane Attorney',
          name: 'Draft contract revisions',
        },
      ],
      flatFees: [
        {
          id: 'ff-1',
          date: '2026-08-12',
          amount: 450.0,
          description: 'Filing fee',
        },
      ],
    };

    const output = generateLedesExport({
      invoice,
      lawFirm: baseLawFirm,
      client: baseClient,
    });

    const lines = output.split('\r\n');
    expect(lines[0]).toBe('LEDES1998B[]');
    expect(lines[1]).toContain('INVOICE_DATE|INVOICE_NUMBER|CLIENT_ID|LAW_FIRM_MATTER_ID|INVOICE_TOTAL');
    expect(lines[1].endsWith('[]')).toBe(true);

    // 2 data rows + header + columns
    expect(lines).toHaveLength(4);

    // Line 1: Time entry
    const row1 = lines[2].replace(/\[\]$/, '').split('|');
    expect(row1[0]).toBe('20260815'); // INVOICE_DATE
    expect(row1[1]).toBe('INV-2026-001'); // INVOICE_NUMBER
    expect(row1[2]).toBe('client-uuid-1'); // CLIENT_ID
    expect(row1[4]).toBe('1500.00'); // INVOICE_TOTAL
    expect(row1[5]).toBe('20260810'); // BILLING_START_DATE
    expect(row1[6]).toBe('20260812'); // BILLING_END_DATE
    expect(row1[7]).toBe('Monthly billing for corporate counsel'); // INVOICE_DESCRIPTION
    expect(row1[8]).toBe('1'); // LINE_ITEM_NUMBER
    expect(row1[9]).toBe('F'); // EXP/FEE/INV_ADJ_TYPE
    expect(row1[10]).toBe('3.50'); // UNITS
    expect(row1[11]).toBe('0.00'); // ADJ
    expect(row1[12]).toBe('1050.00'); // TOTAL
    expect(row1[13]).toBe('20260810'); // LINE_ITEM_DATE
    expect(row1[14]).toBe('L110'); // TASK_CODE
    expect(row1[15]).toBe('A101'); // ACTIVITY_CODE
    expect(row1[16]).toBe('usr-1'); // TIMEKEEPER_ID
    expect(row1[17]).toBe('Jane Attorney'); // TIMEKEEPER_NAME
    expect(row1[18]).toBe('Draft contract revisions'); // DESCRIPTION
    expect(row1[19]).toBe('firm-uuid-1'); // LAW_FIRM_ID
    expect(row1[20]).toBe('300.00'); // UNIT_COST

    // Line 2: Flat fee
    const row2 = lines[3].replace(/\[\]$/, '').split('|');
    expect(row2[8]).toBe('2'); // LINE_ITEM_NUMBER
    expect(row2[9]).toBe('F'); // EXP/FEE/INV_ADJ_TYPE
    expect(row2[10]).toBe('1.00'); // UNITS
    expect(row2[12]).toBe('450.00'); // TOTAL
    expect(row2[13]).toBe('20260812'); // LINE_ITEM_DATE
    expect(row2[18]).toBe('Filing fee'); // DESCRIPTION
    expect(row2[20]).toBe('450.00'); // UNIT_COST
  });

  // A real invoice carries BOTH `totalAmount` (which already folds in flat fees)
  // and a separate `flatFeesAmount` for the same fees; the export must treat them
  // as a fallback, not add them. That regression is pinned on a real persisted
  // invoice, through the export route, in `invoiceSurfaceConsistency.test.ts`.

  it('sanitizes pipe delimiters and newlines in text fields', () => {
    const invoice = {
      id: 'inv-2',
      invoiceName: 'INV|2026|002\r\nSpecial',
      invoiceDate: '2026-08-01',
      notes: 'Line 1 | Note\nLine 2',
      timeEntries: [
        {
          id: 'te-2',
          date: '2026-08-01',
          hours: 1.0,
          rate: 100.0,
          name: 'Consultation | with client\r\nand partner',
          utbmsTaskCode: 'L|100',
          utbmsActivityCode: 'A|100',
          userName: 'John|Doe\nEsq',
        },
      ],
    };

    const output = generateLedesExport({
      invoice,
      lawFirm: { id: 'firm|1' },
      client: { id: 'client|1', name: 'Client|Name' },
    });

    const lines = output.split('\r\n');
    const row = lines[2].replace(/\[\]$/, '').split('|');

    // 21 columns exactly, pipe sanitization prevented column drift
    expect(row).toHaveLength(21);
    expect(row[1]).toBe('INV 2026 002  Special');
    expect(row[2]).toBe('client 1');
    expect(row[7]).toBe('Line 1   Note Line 2');
    expect(row[14]).toBe('L 100');
    expect(row[15]).toBe('A 100');
    expect(row[17]).toBe('John Doe Esq');
    expect(row[18]).toBe('Consultation   with client  and partner');
    expect(row[19]).toBe('firm 1');
  });

  it('computes billing start and end date when dates are scattered across entries', () => {
    const invoice = {
      id: 'inv-3',
      invoiceDate: '2026-08-20',
      timeEntries: [
        { date: '2026-08-05', hours: 1, rate: 100 },
        { date: '2026-08-15', hours: 2, rate: 100 },
      ],
      flatFees: [
        { date: '2026-08-01', amount: 50 },
        { date: '2026-08-18', amount: 50 },
      ],
    };

    const output = generateLedesExport({
      invoice,
      lawFirm: baseLawFirm,
      client: baseClient,
    });

    const lines = output.split('\r\n');
    const row = lines[2].replace(/\[\]$/, '').split('|');

    // Min date is 2026-08-01 (flat fee), max date is 2026-08-18 (flat fee)
    expect(row[5]).toBe('20260801'); // BILLING_START_DATE
    expect(row[6]).toBe('20260818'); // BILLING_END_DATE
  });

  it('handles empty line items and falls back to invoice date for billing period', () => {
    const invoice = {
      id: 'inv-4',
      createdAt: '2026-08-01T00:00:00Z',
      totalAmount: 0,
      timeEntries: [],
      flatFees: [],
    };

    const output = generateLedesExport({
      invoice,
      lawFirm: null,
      client: null,
    });

    const lines = output.split('\r\n');
    expect(lines).toHaveLength(2); // Header + Columns, no data rows
    expect(lines[0]).toBe('LEDES1998B[]');
  });

  it('falls back to rate * hours when amount is missing on time entry', () => {
    const invoice = {
      id: 'inv-5',
      invoiceDate: '2026-08-01',
      timeEntries: [
        {
          hours: 2.5,
          rate: 200.0,
          // amount intentionally omitted
        },
      ],
    };

    const output = generateLedesExport({
      invoice,
      lawFirm: baseLawFirm,
      client: baseClient,
    });

    const lines = output.split('\r\n');
    const row = lines[2].replace(/\[\]$/, '').split('|');
    expect(row[10]).toBe('2.50'); // UNITS
    expect(row[12]).toBe('500.00'); // TOTAL = 2.5 * 200
    expect(row[20]).toBe('200.00'); // UNIT_COST
  });

  it('handles fallback identifiers when primary fields are absent', () => {
    const invoice = {
      id: 'inv-fallback-id',
      createdAt: '2026-07-15T12:00:00Z',
      clientId: 'inv-client-id',
      clientName: 'Invoice Level Client',
      entityId: 'matter-entity-id',
      totalAmount: 100,
      timeEntries: [
        {
          timekeeperId: 'tk-id-1',
          memberName: 'Member Name 1',
          description: 'Description fallback',
          hours: 1,
          rate: 100,
        },
      ],
    };

    const output = generateLedesExport({
      invoice,
      lawFirm: undefined,
      client: undefined,
    });

    const lines = output.split('\r\n');
    const row = lines[2].replace(/\[\]$/, '').split('|');
    expect(row[0]).toBe('20260715'); // INVOICE_DATE from createdAt
    expect(row[1]).toBe('inv-fallback-id'); // INVOICE_NUMBER from id
    expect(row[2]).toBe('inv-client-id'); // CLIENT_ID from invoice.clientId
    expect(row[3]).toBe('matter-entity-id'); // MATTER_ID from invoice.entityId
    expect(row[16]).toBe('tk-id-1'); // TIMEKEEPER_ID from entry.timekeeperId
    expect(row[17]).toBe('Member Name 1'); // TIMEKEEPER_NAME from entry.memberName
    expect(row[18]).toBe('Description fallback'); // DESCRIPTION from entry.description
  });
});
