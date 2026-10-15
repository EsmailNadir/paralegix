jest.unmock('@/services/admin.service');
jest.unmock('@/services/requestDeduplicator');

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import FeatureOverridesModal from '@/components/adminComp/FeatureOverridesModal';
import LimitsOverrideModal from '@/components/adminComp/LimitsOverrideModal';
import StorageOpsModal from '@/components/adminComp/StorageOpsModal';
import type { AdminPlanData } from '@/services/admin.service';
import { __resetDuplicateRequestGuard } from '@/lib/utils/duplicateRequestGuard';
import { installApiMock, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';

const FIRM = 'firm-1';
const PLAN_URL = `/api/admin/lawfirms/${FIRM}/plan`;
const FIRM_URL = `/api/admin/lawfirms/${FIRM}`;
const MB = 1024 * 1024;
let api: ApiMock;
beforeEach(() => {
  __resetDuplicateRequestGuard();
  api = installApiMock();
  api.getExact(PLAN_URL, { lawFirm: { id: FIRM }, limits: {}, features: {}, usage: {} });
});
afterEach(() => api.restore());

// Red if initialization runs on each parent render and discards a draft, does
// not run on reopen, or loses the domain-specific override serialization.
describe.each(['features', 'limits', 'storage'] as const)('%s override initialization', (kind) => {
  function setup() {
    const onClose = jest.fn();
    const onSaved = jest.fn();
    const plan: AdminPlanData = {
      planId: 'plan-1', billingStatus: 'active', billingInterval: null, planPriceCents: null,
      stripePriceId: null, comped: false, compedReason: null, unlimitedOverride: false,
      cancelAtPeriodEnd: false, stripeCustomerId: null, stripeSubscriptionId: null,
      currentPeriodEnd: null, currentPeriodStart: null, trialEndsAt: null,
      lastPaymentAt: null, lastPaymentAmount: null, assignedAt: null, assignedBy: null,
      featureOverrides: { clientPortal: true }, limitOverrides: { maxMatters: 5, storageQuotaBytes: 2 * MB },
    };
    const element = (open: boolean, updated = false) => {
      const props = { open, onClose, onSaved, lawFirmId: FIRM };
      if (kind === 'features') return <FeatureOverridesModal {...props} plan={updated ? { ...plan, featureOverrides: { clientPortal: false } } : plan} />;
      if (kind === 'limits') return <LimitsOverrideModal {...props} plan={updated ? { ...plan, limitOverrides: { maxMatters: 7 } } : plan} />;
      return <StorageOpsModal {...props} storage={{ hardLimit: true, warnAtPercent: updated ? 90 : 80, usedBytes: MB, quotaBytes: 2 * MB }} />;
    };
    const read = () => kind === 'features'
      ? within(screen.getByText('Client Portal').parentElement as HTMLElement).getByText(/^(Enabled|Disabled|Plan default)$/).textContent
      : (screen.getByLabelText(kind === 'limits' ? 'Max Matters' : 'Warn At (%)') as HTMLInputElement).value;
    const change = () => {
      if (kind === 'features') {
        fireEvent.click(within(screen.getByText('Client Portal').parentElement as HTMLElement).getByRole('button'));
        fireEvent.click(screen.getByRole('option', { name: 'Disabled' }));
      } else {
        fireEvent.change(screen.getByLabelText(kind === 'limits' ? 'Max Matters' : 'Warn At (%)'), { target: { value: '42' } });
      }
    };
    return { ...renderWithProviders(element(true)), element, read, change, onClose, onSaved };
  }

  it('keeps a draft across parent renders and uses current props on reopen', async () => {
    const { rerender, element, read, change } = setup();
    expect(read()).toBe(kind === 'features' ? 'Enabled' : kind === 'limits' ? '5' : '80');
    change();
    rerender(element(true, true));
    expect(read()).toBe(kind === 'features' ? 'Disabled' : '42');
    rerender(element(false, true));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    rerender(element(true, true));
    expect(read()).toBe(kind === 'features' ? 'Disabled' : kind === 'limits' ? '7' : '90');
  });

  it('sends its existing override payload and closes on success', async () => {
    const url = kind === 'storage' ? FIRM_URL : PLAN_URL;
    api.patchExact(url, { lawFirm: { id: FIRM } });
    const { change, onClose, onSaved } = setup();
    change();
    fireEvent.click(screen.getByRole('button', { name: kind === 'features' ? 'Save Features' : kind === 'limits' ? 'Save Overrides' : 'Save Settings' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(api.calls('PATCH')).toHaveLength(1);
    expect(api.calls('PATCH')[0].body).toEqual(kind === 'features'
      ? { featureOverrides: { clientPortal: false } }
      : kind === 'limits' ? { limitOverrides: { maxMatters: 42, storageQuotaBytes: 2 * MB } }
        : { storage: { hardLimit: true, warnAtPercent: 42 } });
    expect(onSaved).toHaveBeenCalledWith({ id: FIRM });
  });

  it('keeps the dialog open while its save is in flight', async () => {
    let finish!: (value: unknown) => void;
    api.patchExact(kind === 'storage' ? FIRM_URL : PLAN_URL, () => new Promise((resolve) => { finish = resolve; }));
    const { change, onClose } = setup();
    change();
    fireEvent.click(screen.getByRole('button', { name: kind === 'features' ? 'Save Features' : kind === 'limits' ? 'Save Overrides' : 'Save Settings' }));
    await waitFor(() => expect(api.calls('PATCH')).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('dialog').parentElement!.previousElementSibling!);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { finish({ lawFirm: { id: FIRM } }); });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });
});
