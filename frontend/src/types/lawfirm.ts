
import type { FirmFeatures, FirmSettings } from './preferences';
import type { BillingStatus, PlanId } from './subscription';

export type LawFirmPlan = {
  planId?: PlanId;
  billingStatus?: BillingStatus;
  comped?: boolean;
  unlimitedOverride?: boolean;
  featureOverrides?: Partial<FirmFeatures>;
  /** Trial end, ISO. Read by the billing gate when the status endpoint is unavailable. */
  trialEndsAt?: string | null;
  /** Set once Stripe tracks the subscription; a trial without one expires by date. */
  stripeSubscriptionId?: string | null;
};

export type LawFirm = {
  id: string;
  name: string;
  description?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  phone?: string;
  email?: string;
  logoUrl?: string;
  settings?: Partial<FirmSettings>;
  plan?: LawFirmPlan;
  invoiceReminderEnabled?: boolean;
  invoiceReminderDays?: number[];
  defaultPreDueReminderDays?: number | null;
  createdAt?: string | null;
};

/** The firm contact fields a firm may leave empty; an update clears one by sending null. */
export type LawFirmClearableField = 'description' | 'address' | 'city' | 'state' | 'zip' | 'phone' | 'email';

/** The body of a firm update. */
export type LawFirmUpdate = Partial<Omit<LawFirm, LawFirmClearableField>> & {
  [K in LawFirmClearableField]?: string | null;
};
