# Roadmap

Planned features and larger initiatives. Rough priority only, not dated
commitments. Update as priorities shift.

## Near term

- **Trust / Stripe compliance rework — remaining rollout.** The code has landed
  on `staging` (ACH-only trust deposits, per-trust-account connected accounts,
  fees billed to the firm's operating side). What is left is environment work:
  applying migrations `0092`/`0093`, subscribing the new payment-intent and
  charge events on the Stripe webhook endpoint, enabling `us_bank_account` on
  the platform account, and remediating the pre-existing deposits listed by
  `backend/scripts/report-stripe-trust-deposits.ts`. Checklist in
  [Trust / Stripe Compliance](/TRUST_STRIPE_COMPLIANCE).
- **Direct-charge migration.** Phase 0 (the cutover flag and `charge_model`
  markers) is in; Phases 1-5 are blocked on product sign-off for fee re-pricing
  and merchant-of-record communication. See
  [Direct Charge Migration](/DIRECT_CHARGE_MIGRATION). Do not start without it.
- **Data-subject erasure flow.** A first-class "delete my data" path for clients,
  beyond the current manual process. See
  [Privacy & Data Rights](/dev/security/privacy-data-rights).
- **Audit log surface.** Persist and expose a queryable audit trail for
  sensitive actions. Background in [Audit Logging](/dev/security/audit-logging).

## Medium term

- **Role defaults and least-privilege review.** Tighten the default permission
  set for new roles. See [RBAC & Permissions](/dev/security/rbac-permissions).
- **Data retention policies.** Configurable retention and automated cleanup for
  closed matters and their artifacts.
- **Accessibility pass on modals.** Focus trapping, escape handling, and ARIA
  roles across the shared modal primitives.

## Longer term / exploratory

- **Secrets rotation.** A documented, low-downtime rotation procedure for the
  application secrets listed in [Secrets](/dev/security/secrets).
- **Reporting and analytics depth.** Richer billing and matter analytics beyond
  the current [Billing reports](/billing/reports).

## Adding an item

Give each entry a one-line "what" and a link to the code or ops doc that explains
the "where." Move it out of this page when it ships.
