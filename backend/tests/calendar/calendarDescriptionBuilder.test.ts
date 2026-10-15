jest.mock('../../src/shared/database/queryContext', () => ({
  privilegedParameterizedQuery: jest.fn(),
}));
jest.mock('../../src/shared/utils/isUuid', () => ({
  isUuid: (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value),
}));

import { privilegedParameterizedQuery } from '../../src/shared/database/queryContext';
import {
  buildBillingCalendarDescription,
  buildClientEventCalendarDescription,
  buildExternalEventCalendarDescription,
  buildMatterEventCalendarDescription,
  buildTaskCalendarDescription,
} from '../../src/modules/calendar/shared/calendarDescriptionBuilder';

const queryMock = privilegedParameterizedQuery as jest.Mock;
const UUID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  queryMock.mockReset();
});

describe('calendar description builders', () => {
  it('builds an external event without leaking blank sections', async () => {
    await expect(buildExternalEventCalendarDescription(
      { title: 'Outside consultation', notes: 'Bring documents' },
      '[source:calendar]',
    )).resolves.toBe(
      'External event: Outside consultation\n\nBring documents\n\n[source:calendar]',
    );
  });

  it('uses description when an external event has no notes and a fallback title', async () => {
    await expect(buildExternalEventCalendarDescription(
      { title: '  ', description: 'Imported description' },
      null,
    )).resolves.toBe('External event: Untitled event\n\nImported description');
  });

  it('formats a billing installment with all available context', async () => {
    await expect(buildBillingCalendarDescription(
      {
        clientName: 'Acme Corporation',
        matterName: 'Acquisition',
        invoiceName: 'March installment',
        invoiceNumber: 'INV-42',
      },
      { billingItemType: 'installment', scheduledAmount: 1250, scheduledDate: '2026-09-01' },
      '[billing]',
    )).resolves.toContain('Payment plan installment');
    await expect(buildBillingCalendarDescription(
      { clientName: 'Acme Corporation' },
      { billingItemType: 'installment', scheduledAmount: 1250, scheduledDate: '2026-09-01' },
      '[billing]',
    )).resolves.toEqual(expect.stringContaining('Amount due: $1250.00'));
  });

  it('uses invoice due date for non-installment billing items and omits invalid amounts', async () => {
    const description = await buildBillingCalendarDescription(
      {},
      { billingItemType: 'invoice', scheduledAmount: '1250', scheduledDate: '2026-09-01' },
      null,
    );

    expect(description).toContain('Invoice due date');
    expect(description).toContain('Date: 2026-09-01');
    expect(description).not.toContain('Amount due');
  });

  it('deduplicates matter clients by normalized name and phone', async () => {
    queryMock.mockResolvedValue({ rows: [
      { id: UUID, name: '  Acme Corporation ', phone: ' 555-0100 ' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'acme corporation', phone: '555-0100' },
      { id: '33333333-3333-4333-8333-333333333333', name: 'Bea Billing', phone: null },
    ] });

    const description = await buildMatterEventCalendarDescription(
      { lawFirmId: UUID, matterId: UUID, type: 'hearing', title: 'Status hearing' },
      '[matter event]',
    );

    expect(description).toContain('Clients:\nAcme Corporation - 555-0100\nBea Billing');
    expect(description.match(/Acme Corporation/g)).toHaveLength(1);
    expect(description).toContain('Hearing: Status hearing');
  });

  it('falls back to Event and includes location and notes for unknown matter events', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await expect(buildMatterEventCalendarDescription(
      { lawFirmId: UUID, matterId: UUID, type: 'new_type', title: '', locationName: 'Room 4', notes: 'Arrive early' },
      null,
    )).resolves.toBe('Event: Untitled event\n\nLocation: Room 4\n\nArrive early');
  });

  it('uses fallback names for valid firm client ids and ignores invalid ids', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: UUID, name: 'Named Client', phone: '555-0101' }] });

    const description = await buildTaskCalendarDescription(
      {
        lawFirmId: UUID,
        clientIds: [UUID, 'not-a-uuid', '44444444-4444-4444-8444-444444444444'],
        clientNames: ['Named Client', 'Invalid Client', 'Fallback Client'],
        description: 'Prepare intake',
      },
      '[task]',
    );

    expect(description).toContain('Clients:\nNamed Client - 555-0101\nInvalid Client\nFallback Client');
    expect(description).toContain('Prepare intake');
  });

  it('returns a client event description when the client lookup fails', async () => {
    queryMock.mockRejectedValue(new Error('database unavailable'));

    await expect(buildClientEventCalendarDescription(
      { lawFirmId: UUID, clientId: UUID, type: 'mediation', title: 'Mediation', notes: 'Remote' },
      '[client event]',
    )).resolves.toBe(
      `Mediation: Mediation\n\nRemote\n\nOpen in Paralegix: ${(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}/lawfirm/${UUID}/clients/${UUID}?tab=events\n[client event]`,
    );
  });
});


it('uses an external description when notes contain only whitespace', async () => {
  await expect(buildExternalEventCalendarDescription(
    { title: 'Consultation', notes: ' \n ', description: 'Bring documents' },
    '(External event from Paralegix)',
  )).resolves.toBe('External event: Consultation\n\nBring documents\n\n(External event from Paralegix)');
});
