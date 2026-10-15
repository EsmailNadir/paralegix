import { apiFetch } from "@/lib/utils/fetchWithTokenRefresh";
import { toApiError } from "@/lib/utils/apiErrors";
import requestDeduplicator from "@/services/requestDeduplicator";
import { authenticatedHeaders } from './base.service';
import type {
  SubscriptionStatus,
  CheckoutResponse,
  PortalResponse,
  PlanId,
  BillingInterval,
} from "@/types/subscription";

class SubscriptionService {
  private baseApi: string;

  constructor() {
    const API_URL =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:5001/api";
    this.baseApi = API_URL.replace(/\/$/, "");
  }

  private getBase(lawFirmId: string): string {
    return `${this.baseApi}/lawfirms/${encodeURIComponent(lawFirmId)}/subscriptions`;
  }

  private async getAuthHeaders(options?: {
    json?: boolean;
  }): Promise<HeadersInit> {
    const headers = await authenticatedHeaders();
    if (options?.json !== false) {
      headers["Content-Type"] = "application/json";
    }
    return headers;
  }

  /**
   * Get current subscription status + usage for a law firm.
   *
   * Deduplicated, like every other bootstrap read. The workspace shell, the
   * billing settings page and the post-login destination resolver all ask for
   * this, and more than one of them can be in flight at once: the settings page
   * runs two effects that each want it, and any remount repeats the shell's own
   * call. The deduplicator coalesces only requests that overlap and caches
   * nothing, so a later read still reaches the server.
   */
  async getStatus(lawFirmId: string): Promise<SubscriptionStatus> {
    const headers = await this.getAuthHeaders();
    return requestDeduplicator.execute<SubscriptionStatus>(
      `${this.getBase(lawFirmId)}/status`,
      { headers },
    );
  }

  /** Create a Stripe Checkout session for subscribing or upgrading */
  async createCheckout(
    lawFirmId: string,
    planId: PlanId,
    interval: BillingInterval
  ): Promise<CheckoutResponse> {
    const headers = await this.getAuthHeaders();
    const res = await apiFetch(`${this.getBase(lawFirmId)}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planId, interval }),
    });
    if (!res.ok) {
      throw await toApiError(res, "Failed to create checkout session");
    }
    return res.json();
  }

  /** Create a Stripe Customer Portal session */
  async createPortalSession(lawFirmId: string): Promise<PortalResponse> {
    const headers = await this.getAuthHeaders();
    const res = await apiFetch(`${this.getBase(lawFirmId)}/portal`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      throw await toApiError(res, "Failed to create portal session");
    }
    return res.json();
  }

  /** Change plan tier or billing interval */
  async changePlan(
    lawFirmId: string,
    planId: PlanId,
    interval: BillingInterval
  ): Promise<{ message: string }> {
    const headers = await this.getAuthHeaders();
    const res = await apiFetch(`${this.getBase(lawFirmId)}/change-plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ planId, interval }),
    });
    if (!res.ok) {
      throw await toApiError(res, "Failed to change plan");
    }
    return res.json();
  }

  /** Cancel subscription at end of billing period */
  async cancel(lawFirmId: string): Promise<{ message: string }> {
    const headers = await this.getAuthHeaders();
    const res = await apiFetch(`${this.getBase(lawFirmId)}/cancel`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      throw await toApiError(res, "Failed to cancel subscription");
    }
    return res.json();
  }

  /** Reactivate a cancelled-but-not-yet-expired subscription */
  async reactivate(lawFirmId: string): Promise<{ message: string }> {
    const headers = await this.getAuthHeaders();
    const res = await apiFetch(`${this.getBase(lawFirmId)}/reactivate`, {
      method: "POST",
      headers,
    });
    if (!res.ok) {
      throw await toApiError(res, "Failed to reactivate subscription");
    }
    return res.json();
  }
}

const subscriptionService = new SubscriptionService();
export default subscriptionService;
