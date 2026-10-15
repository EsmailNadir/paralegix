import BaseApiService from './base.service';
import type { CardFeeSettingsState, CardFeeSettingsUpdate } from '@/types/cardFees';

/**
 * The firm's credit card fee setting. It has its own route rather than the
 * generic firm-settings PUT because switching it on is checked: the firm must
 * be connected to Stripe, in a state that allows the fee, and past the 30-day
 * notice it confirms here.
 */
class CardFeesService extends BaseApiService {
  constructor() {
    super('lawfirms');
  }

  getCardFees(lawFirmId: string): Promise<CardFeeSettingsState> {
    return this.request(this.url(lawFirmId, 'billing', 'card-fees'), {
      method: 'GET', errorMessage: 'Failed to load card fee settings',
    });
  }

  updateCardFees(lawFirmId: string, body: CardFeeSettingsUpdate): Promise<CardFeeSettingsState> {
    return this.request(this.url(lawFirmId, 'billing', 'card-fees'), {
      method: 'PUT', body, errorMessage: 'Failed to save card fee settings',
    });
  }
}

const cardFeesService = new CardFeesService();
export default cardFeesService;
