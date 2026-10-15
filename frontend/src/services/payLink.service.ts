import { publicFetch } from '@/lib/utils/fetchWithTokenRefresh';
import { toApiError } from '@/lib/utils/apiErrors';
import type { PaymentMethodKind } from '@/services/client-portal.service';
import type { CardConfirmResult, CardQuote, CardSetup } from '@/types/cardFees';

const API_ROOT = (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5001/api').replace(/\/$/, '');

/** What the no-login pay page shows for one secure payment link. */
export interface PayPage {
  firmName: string | null;
  invoiceName: string | null;
  /** The payment-plan installment (1-based) the link charges; null for the full balance. */
  installmentNumber: number | null;
  dueDate: string | null;
  isPaid: boolean;
  invoiceCents: number;
  methods: Array<{ method: PaymentMethodKind; feeCents: number; totalCents: number }>;
  /** How a card payment is taken: our card form when the client pays the card fee. */
  card: CardSetup;
}

/**
 * The secure payment link's public calls. The token is the only credential,
 * so these send no auth header.
 */
class PayLinkService {
  async getPayPage(token: string): Promise<PayPage> {
    const response = await publicFetch(`${API_ROOT}/pay/${encodeURIComponent(token)}`);
    if (!response.ok) throw await toApiError(response, 'Failed to load this payment link');
    return response.json();
  }

  async startCheckout(token: string, method: PaymentMethodKind): Promise<{ checkoutUrl: string }> {
    const response = await publicFetch(`${API_ROOT}/pay/${encodeURIComponent(token)}/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method }),
    });
    if (!response.ok) throw await toApiError(response, 'Failed to start payment');
    return response.json();
  }

  /** What the entered card pays on this invoice. Charges nothing. */
  quoteCard(token: string, confirmationTokenId: string): Promise<CardQuote> {
    return this.postCard(token, 'quote', { confirmationTokenId }, "We couldn't check this card");
  }

  /** Charge the card, refused unless the total is still the one the client saw. */
  confirmCard(token: string, confirmationTokenId: string, expectedTotalCents: number): Promise<CardConfirmResult> {
    return this.postCard(token, 'confirm', { confirmationTokenId, expectedTotalCents }, "The payment didn't go through");
  }

  /** Record the payment once the client's bank verification step is done. */
  completeCard(token: string, paymentIntentId: string): Promise<CardConfirmResult> {
    return this.postCard(token, 'complete', { paymentIntentId }, "The payment didn't go through");
  }

  private async postCard<T>(token: string, step: 'quote' | 'confirm' | 'complete', body: unknown, fallback: string): Promise<T> {
    const response = await publicFetch(`${API_ROOT}/pay/${encodeURIComponent(token)}/card/${step}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await toApiError(response, fallback);
    return response.json();
  }
}

const payLinkService = new PayLinkService();
export default payLinkService;
