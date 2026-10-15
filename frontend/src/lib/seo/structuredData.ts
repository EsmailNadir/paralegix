/**
 * Schema.org JSON-LD builders shared across the marketing site. Pricing and
 * FAQ content is pulled from `marketingData.ts` (the same source the pricing
 * page renders from) so structured data can't drift from what's on the page.
 */
import { SITE_URL } from "@/lib/seo/site";
import { PLANS, FAQS } from "@/components/marketingComp/marketingData";

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;

export function organizationSchema() {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: "Paralegix",
    legalName: "Paralegix, Inc.",
    url: SITE_URL,
    logo: `${SITE_URL}/img/paralegix-mark-512.png`,
    description:
      "Legal practice management software for law firms, covering matters, documents, calendaring, trust accounting, and billing.",
  };
}

export function websiteSchema() {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: "Paralegix",
    url: SITE_URL,
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * The full feature list a SoftwareApplication offer needs. Mirrors what's
 * actually documented on the homepage and /features, kept as one list since
 * both pages reference the same product.
 */
const FEATURE_LIST = [
  "Matter management with custom fields, tasks, notes, and an activity timeline",
  "Time tracking and flat-fee billing with charge codes",
  "One-click invoicing with online payments",
  "Trust accounting with an append-only ledger and reconciliation",
  "LEDES and UTBMS electronic billing export",
  "Document automation from reusable templates, auto-filled from the matter",
  "Built-in e-signature and version history",
  "Two-way calendar sync with Google Calendar and Outlook",
  "Deadline tracking with layered reminders",
  "Secure client portal with online intake",
  "Secure client messaging, kept off email",
  "Role-based access control and per-firm data isolation",
  "Reporting and analytics dashboards",
  "Practice area organization and a built-in court directory",
];

/**
 * Product-level schema for the app itself, with plan pricing as an
 * AggregateOffer. Safe to embed on any page describing or selling the
 * product (home, pricing) - the `@id` lets multiple embeds resolve to the
 * same graph node instead of being treated as distinct entities.
 */
export function softwareApplicationSchema() {
  return {
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: "Paralegix",
    url: SITE_URL,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Legal Practice Management Software",
    operatingSystem: "Web",
    description:
      "Paralegix unifies matter intake, documents, calendaring, time tracking, trust accounting, and billing into one workspace for law firms, with a secure client portal.",
    provider: { "@id": ORGANIZATION_ID },
    featureList: FEATURE_LIST,
    offers: {
      "@type": "AggregateOffer",
      priceCurrency: "USD",
      lowPrice: "0",
      highPrice: String(Math.max(...PLANS.map((p) => p.monthly))),
      offerCount: PLANS.length,
      offers: PLANS.map((p) => ({
        "@type": "Offer",
        name: `${p.name} plan`,
        description: p.description,
        url: `${SITE_URL}/pricing`,
        price: String(p.monthly),
        priceCurrency: "USD",
        category: p.monthly === 0 ? "Free" : "SaaS subscription",
        ...(p.monthly > 0 && {
          priceSpecification: [
            {
              "@type": "UnitPriceSpecification",
              price: String(p.monthly),
              priceCurrency: "USD",
              unitText: "MONTH",
              description: "Billed monthly",
            },
            {
              "@type": "UnitPriceSpecification",
              price: String(p.annualPerMonth),
              priceCurrency: "USD",
              unitText: "MONTH",
              description: `Billed annually at $${p.annualTotal}/year`,
            },
          ],
        }),
      })),
    },
    // Deliberately no aggregateRating: Paralegix has no public review corpus
    // to source one from, and a fabricated rating is worse than none.
  };
}

export function faqPageSchema() {
  return {
    "@type": "FAQPage",
    mainEntity: FAQS.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function breadcrumbSchema(items: { name: string; path: string }[]) {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: `${SITE_URL}${it.path === "/" ? "" : it.path}`,
    })),
  };
}
