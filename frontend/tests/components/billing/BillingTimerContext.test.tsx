import React from "react";
import { act, screen } from "@testing-library/react";
import { renderWithProviders } from "../../support/renderWithProviders";
import { grantPermissions, resetPermissions } from "../../support/permissions";

const mockGetMatters = jest.fn();
const mockLookupMatters = jest.fn();
const mockListClients = jest.fn();
const mockLookupClients = jest.fn();
const mockGetUsersByLawFirm = jest.fn();
const mockGetChargeCodes = jest.fn();
const mockNavigate = jest.fn();
let mockSaveProps: React.ComponentProps<typeof import('@/components/billingComp/TimeEntryModal').default>;
jest.mock('@/contexts/NavigationContext', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }));

jest.mock("@/services/matters.service", () => ({
  __esModule: true,
  default: {
    getMatters: (...args: unknown[]) => mockGetMatters(...args),
    lookupMatters: (...args: unknown[]) => mockLookupMatters(...args),
  },
}));

jest.mock("@/services/clients.service", () => ({
  __esModule: true,
  default: {
    listClients: (...args: unknown[]) => mockListClients(...args),
    lookupClients: (...args: unknown[]) => mockLookupClients(...args),
  },
}));

jest.mock("@/services/users.service", () => ({
  __esModule: true,
  default: {
    getUsersByLawFirm: (...args: unknown[]) => mockGetUsersByLawFirm(...args),
  },
}));

jest.mock("@/services/chargeCodes.service", () => ({
  __esModule: true,
  chargeCodesService: {
    getChargeCodes: (...args: unknown[]) => mockGetChargeCodes(...args),
  },
}));

// The provider's own fetching is what this file is about. The save modal and the
// floating widget are rendered as stubs so their internals cannot account for a
// request the provider is being asserted not to make.
jest.mock("@/components/billingComp/TimeEntryModal", () => ({
  __esModule: true,
  default: (props: typeof mockSaveProps) => { mockSaveProps = props; return null; },
}));

jest.mock("@/components/billingComp/TimerWidget", () => ({
  __esModule: true,
  default: () => null,
}));

import { BillingTimerProvider, useBillingTimer } from "@/contexts/BillingTimerContext";
let timer: ReturnType<typeof useBillingTimer>;
function TimerProbe() {
  const value = useBillingTimer();
  React.useLayoutEffect(() => { timer = value; });
  return null;
}

function renderProvider() {
  return renderWithProviders(
    <BillingTimerProvider lawFirmId="firm-1">
      <p>app content</p>
      <TimerProbe />
    </BillingTimerProvider>
  );
}

describe("BillingTimerProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    mockNavigate.mockClear();
    for (const mock of [
      mockGetMatters,
      mockLookupMatters,
      mockListClients,
      mockLookupClients,
      mockGetUsersByLawFirm,
      mockGetChargeCodes,
    ]) {
      mock.mockReset();
      mock.mockResolvedValue({ items: [], hasMore: false });
    }
  });

  describe('saving elapsed work', () => {
    beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-10-02T12:00:00Z')); });
    afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

    it.each(['matter', 'client'] as const)('banks the previous %s timer with its attribution before starting another', async (target) => {
      renderProvider();
      const source = {
        targetLabel: 'Previous work', name: 'Research', description: 'Draft motion', chargeCodeId: 'code-a',
        sourceTaskId: 'task-a', sourceTaskTitle: 'Review', sourceEventId: 'event-a', sourceEventTitle: 'Hearing',
        sourceMatterId: 'matter-a', sourceClientIds: ['client-a', 'client-b'],
        ...(target === 'matter' ? { matterId: 'matter-a' } : { clientId: 'client-a' }),
      };
      act(() => timer.startTimer(source));
      act(() => { jest.advanceTimersByTime(900_000); });
      await act(async () => timer.startTimer({ clientId: 'client-next', targetLabel: 'Next work' }));
      expect(mockSaveProps.open).toBe(true);
      expect(mockSaveProps.prefill).toEqual({
        hours: 0.25, matterId: target === 'matter' ? 'matter-a' : null,
        clientId: target === 'client' ? 'client-a' : null,
        name: source.name, description: source.description, chargeCodeId: source.chargeCodeId,
        sourceTaskId: source.sourceTaskId, sourceTaskTitle: source.sourceTaskTitle,
        sourceEventId: source.sourceEventId, sourceEventTitle: source.sourceEventTitle,
        sourceMatterId: source.sourceMatterId, sourceClientIds: source.sourceClientIds,
      });
      expect(timer.isRunning).toBe(true);
      expect(timer.clientId).toBe('client-next');
      act(() => mockSaveProps.onClose());
      expect(timer.clientId).toBe('client-next');
      expect(timer.isRunning).toBe(true);
    });

    it('drops only elapsed work too short to round to a hundredth of an hour', () => {
      renderProvider();
      act(() => timer.startTimer({ matterId: 'a', targetLabel: 'A' }));
      act(() => { jest.advanceTimersByTime(1000); });
      act(() => timer.startTimer({ matterId: 'b', targetLabel: 'B' }));
      expect(mockSaveProps.open).toBe(false);
      expect(timer.matterId).toBe('b');
    });

    it('hands a paused timer to the save modal when stopped', async () => {
      renderProvider();
      act(() => timer.startTimer({ matterId: 'a', targetLabel: 'A' }));
      act(() => { jest.advanceTimersByTime(900_000); });
      act(() => timer.pauseTimer());
      act(() => { jest.advanceTimersByTime(900_000); });
      await act(async () => timer.stopTimer());
      expect(mockSaveProps.prefill?.hours).toBe(0.25);
      expect(mockSaveProps.prefill?.matterId).toBe('a');
      expect(mockSaveProps.open).toBe(true);
      expect(timer.isActive).toBe(false);
    });
  });

  it("renders its children", () => {
    renderProvider();
    expect(screen.getByText("app content")).toBeInTheDocument();
  });

  // This provider is mounted on every law-firm route, so a list fetch here is a
  // list fetch on every page in the app.
  it("does not fetch the firm's matter or client list at mount", () => {
    renderProvider();

    expect(mockGetMatters).not.toHaveBeenCalled();
    expect(mockListClients).not.toHaveBeenCalled();
  });

  it("does not run the matter or client typeahead at mount", () => {
    renderProvider();

    expect(mockLookupMatters).not.toHaveBeenCalled();
    expect(mockLookupClients).not.toHaveBeenCalled();
  });

  it("holds the member and charge-code catalogs back until the save modal opens", () => {
    renderProvider();

    expect(mockGetUsersByLawFirm).not.toHaveBeenCalled();
    expect(mockGetChargeCodes).not.toHaveBeenCalled();
  });
});

describe("BillingTimerProvider charge codes", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-02T12:00:00Z'));
    mockGetChargeCodes.mockReset().mockResolvedValue({ chargeCodes: [] });
    mockGetUsersByLawFirm.mockReset().mockResolvedValue([]);
  });
  afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); resetPermissions(); });

  async function openSaveModal() {
    renderProvider();
    act(() => timer.startTimer({ matterId: 'a', targetLabel: 'A' }));
    act(() => { jest.advanceTimersByTime(900_000); });
    await act(async () => timer.stopTimer());
    expect(mockSaveProps.open).toBe(true);
    await act(async () => { await Promise.resolve(); });
  }

  // The charge-code list route answers 403 without billing.viewRates, and a member who can only
  // log time still gets this modal. Red if: the read is sent anyway.
  it("does not read charge codes for the save modal without billing.viewRates", async () => {
    grantPermissions(['billing.manageTimeEntries']);

    await openSaveModal();

    expect(mockGetChargeCodes).not.toHaveBeenCalled();
    expect(mockSaveProps.chargeCodes).toEqual([]);
  });

  it("reads charge codes once the save modal opens for a member who can view rates", async () => {
    grantPermissions(['billing.manageTimeEntries', 'billing.viewRates']);

    await openSaveModal();

    expect(mockGetChargeCodes).toHaveBeenCalledTimes(1);
  });
});
