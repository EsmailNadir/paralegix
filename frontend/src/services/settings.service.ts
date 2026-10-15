import BaseApiService from './base.service';
import type { ClientSettings, FirmFeatureKey, FirmSettings, UserPreferences, WritableUserPreferences } from '@/types/preferences';

type UserSettingsResponse = { preferences: UserPreferences };

/**
 * The card fee is switched on only through PUT /billing/card-fees, which checks
 * the firm may use it and records its confirmation, so the generic firm-settings
 * route refuses `billing.cardFees` and a client-paid `processingFees.card`.
 * Billing saves spread the whole `settings.billing` they hold, so both keys are
 * dropped here; the server deep-merges the patch and keeps what is stored.
 */
function withoutCardFeeKeys(settings: Partial<FirmSettings>): Partial<FirmSettings> {
  if (!settings.billing) return settings;
  const billing: Record<string, unknown> = { ...settings.billing };
  delete billing.cardFees;
  if (settings.billing.processingFees) billing.processingFees = { bank: settings.billing.processingFees.bank };
  return { ...settings, billing: billing as FirmSettings["billing"] };
}

class SettingsService extends BaseApiService {
  constructor() {
    super();
  }

  getFirmSettings(lawFirmId: string): Promise<FirmSettings> {
    return this.dedupedGet<{ settings: FirmSettings }>(
      this.url('lawfirms', lawFirmId, 'settings', 'firm'),
      { errorMessage: 'Failed to load firm settings' },
    ).then(({ settings }) => settings);
  }

  updateFirmSettings(lawFirmId: string, settings: Partial<FirmSettings>): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'settings', 'firm'), {
      method: 'PUT', body: { settings: withoutCardFeeKeys(settings) }, errorMessage: 'Failed to update firm settings',
    });
  }

  // Switch one plan-allowed feature off (or back on) for the firm. Separate from
  // updateFirmSettings because the firm-settings PUT deliberately drops
  // `features`: a value sent there is silently ignored, not applied.
  setFirmFeature(
    lawFirmId: string,
    feature: FirmFeatureKey,
    enabled: boolean,
  ): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'settings', 'features', feature), {
      method: 'PUT', body: { enabled }, errorMessage: 'Failed to update feature',
    });
  }

  lockSetting(lawFirmId: string, key: string, value: unknown): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'settings', 'lock'), {
      method: 'POST', body: { key, value }, errorMessage: 'Failed to lock setting',
    });
  }

  unlockSetting(lawFirmId: string, key: string): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'settings', 'unlock'), {
      method: 'POST', body: { key }, errorMessage: 'Failed to unlock setting',
    });
  }

  getUserSettings(lawFirmId?: string): Promise<UserSettingsResponse> {
    const url = new URL(this.url('settings', 'user'));
    if (lawFirmId) url.searchParams.set('lawFirmId', lawFirmId);
    return this.dedupedGet(url.toString(), { errorMessage: 'Failed to load user settings' });
  }

  /**
   * Typed to the writable keys only: the API derives the calendar connection
   * fields from the stored grant and answers 400 to any write of them.
   */
  updateUserSettings(preferences: Partial<WritableUserPreferences>, lawFirmId?: string): Promise<{ message: string }> {
    const url = new URL(this.url('settings', 'user'));
    if (lawFirmId) url.searchParams.set('lawFirmId', lawFirmId);
    return this.request(url.toString(), {
      method: 'POST', body: { preferences }, errorMessage: 'Failed to update user settings',
    });
  }

  getClientSettings(lawFirmId: string, clientId: string): Promise<ClientSettings> {
    return this.dedupedGet<{ settings: ClientSettings }>(
      this.url('lawfirms', lawFirmId, 'clients', clientId, 'settings'),
      { errorMessage: 'Failed to load client settings' },
    ).then(({ settings }) => settings);
  }

  updateClientSettings(lawFirmId: string, clientId: string, settings: Partial<ClientSettings>): Promise<{ message: string }> {
    return this.request(this.url('lawfirms', lawFirmId, 'clients', clientId, 'settings'), {
      method: 'PUT', body: { settings }, errorMessage: 'Failed to update client settings',
    });
  }

  getPortalClientSettings(lawFirmId: string, clientRecordId?: string): Promise<ClientSettings> {
    const url = new URL(this.url('client-portal', 'lawfirm', lawFirmId, 'settings'));
    if (clientRecordId) url.searchParams.set('clientRecordId', clientRecordId);
    return this.dedupedGet<{ settings: ClientSettings }>(
      url.toString(),
      { errorMessage: 'Failed to load portal settings' },
    ).then(({ settings }) => settings);
  }

  updatePortalClientSettings(lawFirmId: string, settings: Partial<ClientSettings>, clientRecordId?: string): Promise<{ message: string }> {
    // `clientRecordId` MUST travel as a query param, never in the body: the
    // backend's update schema is `.strict()` (only the settings keys it
    // persists are allowed), so an extra body field fails validation instead
    // of silently passing through.
    const url = new URL(this.url('client-portal', 'lawfirm', lawFirmId, 'settings'));
    if (clientRecordId) url.searchParams.set('clientRecordId', clientRecordId);
    return this.request(url.toString(), {
      method: 'PUT', body: { settings }, errorMessage: 'Failed to update portal settings',
    });
  }
}

const settingsService = new SettingsService();
export default settingsService;
