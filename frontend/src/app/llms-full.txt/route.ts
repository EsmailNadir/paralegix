import { SITE_URL, IS_INDEXABLE } from "@/lib/seo/site";
import { PLANS, FAQS, PRACTICE_AREAS } from "@/components/marketingComp/marketingData";

/**
 * llms-full.txt: the expanded companion to /llms.txt, with the actual
 * marketing copy inlined as plain markdown instead of links. Pricing and FAQ
 * sections are generated from marketingData.ts (the pricing page's own data
 * source) so they can't drift from what the site actually shows.
 */
export const revalidate = 3600;

function planSection(): string {
  return PLANS.map((p) => {
    const price =
      p.monthly === 0
        ? "Free forever"
        : `$${p.monthly}/mo billed monthly, or $${p.annualPerMonth}/mo ($${p.annualTotal}/yr) billed annually`;
    const features = p.features.map((f) => ` - ${f}`).join("\n");
    return `### ${p.name} · ${price}\n${p.description}\n\n${features}`;
  }).join("\n\n");
}

function faqSection(): string {
  return FAQS.map((f) => `**${f.q}**\n${f.a}`).join("\n\n");
}

function buildLlmsFullTxt(): string {
  return `# Paralegix - full reference

> Paralegix is a cloud-based legal practice management platform for law firms. It unifies matter (case) intake, documents, calendaring, time tracking, trust accounting, and billing into one workspace, with a secure client portal for clients to message, sign, share files, and pay online. Paralegix is a software tool, not a law firm, and does not provide legal advice.

Canonical site: ${SITE_URL}
Short index: ${SITE_URL}/llms.txt

## What Paralegix does

Every matter is a single source of truth: parties, deadlines, tasks, notes, time entries, and every document, on one timeline the whole firm can trust. Work flows from intake to invoice without re-keying data between tools.

## Features

### Document automation
Build reusable templates for engagement letters, agreements, wills, and the forms a firm reuses every week. Documents auto-fill from the matter (client names, dates, matter details), keep full version history, and go out for e-signature without leaving the matter.

### Matter management
A single timeline per matter covering custom fields per practice area, tasks, contacts, notes, documents, and time entries. Role-based access keeps sensitive matters on a need-to-know basis, and an activity timeline shows who did what and when.

### Time, billing & trust accounting
Capture billable time and flat fees with charge codes, generate invoices in a click, and collect payment online. LEDES and UTBMS export is available for clients who require structured electronic billing. Trust accounting runs on an append-only ledger - completed entries cannot be edited or deleted, only corrected with reversing entries - with built-in reconciliation.

### Deadlines & calendar
Deadlines and reminders stay in one place with layered alerts, and sync two ways with both Google Calendar and Outlook, so nothing slips because it lived in a calendar the rest of the team couldn't see.

### Client portal & intake
Online intake creates the client and matter automatically. Clients get a secure portal to share documents, sign, message the firm, and pay invoices online - all tied to their matter and kept off email.

### Reporting & insights
Dashboards for billable time, invoicing, and matter activity, exportable for partners.

### Security & access control
- Role-based permissions scoped to each team member, with strict per-firm data isolation (every query is scoped to the firm; messaging is row-level secured).
- Data encrypted in transit and at rest, on managed Postgres and cloud storage.
- Sensitive actions are logged so firms can always see who did what, and when.
- Sign-in via Google, Microsoft, or email authentication with verified email.

### Practice areas
Paralegix organizes matters by practice area and includes a built-in court directory. Commonly used for: ${PRACTICE_AREAS.join(", ")}.

## Workflow: how a matter moves through Paralegix

1. **Intake & onboarding** - A prospective client completes an online intake form. Paralegix creates the client and the matter from their answers, with no re-keying.
2. **Open the matter and plan** - Accept the lead and a full matter opens, pre-filled from intake. Apply a matter template and standard tasks, the responsible attorney, and assignments drop into place automatically.
3. **Deadlines, tracked and synced** - Key dates get layered reminders and two-way sync to each attorney's Google or Outlook calendar.
4. **Do the work, all in one place** - Draft documents from a template, log time as you go, and exchange documents and messages with the client through the secure portal. Everything lands back on the matter timeline.
5. **Bill and get paid** - Turn tracked time and expenses into a clean invoice, send it for online payment, and apply funds from trust, with every entry recorded on an append-only ledger.

## Pricing

All plans can be created without a credit card, upgraded or downgraded at any time, and canceled anytime. Prices in USD.

${planSection()}

## Pricing & billing FAQ

${faqSection()}

## Legal

- Terms of Service: ${SITE_URL}/terms
- Privacy Policy: ${SITE_URL}/privacy
- Sub-processors: ${SITE_URL}/subprocessors
- Paralegix is a software tool, not a law firm, and does not provide legal advice.

## Links

- Home: ${SITE_URL}/
- Features: ${SITE_URL}/features
- Workflow: ${SITE_URL}/workflow
- Pricing: ${SITE_URL}/pricing
- Create an account: ${SITE_URL}/register
- Sign in: ${SITE_URL}/login
`;
}

function buildNonCanonicalStub(): string {
  return `# Paralegix (non-canonical deployment)

> This deployment is not the canonical Paralegix site and is not intended to be indexed or cited. See the canonical file instead.

- [Canonical llms-full.txt](${SITE_URL}/llms-full.txt)
`;
}

export function GET() {
  const body = IS_INDEXABLE ? buildLlmsFullTxt() : buildNonCanonicalStub();
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
