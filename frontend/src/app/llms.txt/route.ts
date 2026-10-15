import { SITE_URL, IS_INDEXABLE } from "@/lib/seo/site";
import { PLANS } from "@/components/marketingComp/marketingData";

/**
 * llms.txt (llmstxt.org): a short, curated index of the site for AI agents
 * and answer engines that would otherwise have to render and parse the full
 * page. Kept intentionally brief - links out to /llms-full.txt for depth.
 *
 * Gated the same way as robots.ts: staging/preview deployments serve the
 * same content as production, so pointing them at the canonical file avoids
 * presenting a non-canonical origin as the real site.
 */
export const revalidate = 3600;

function buildLlmsTxt(): string {
  const paid = PLANS.filter((p) => p.monthly > 0)
    .map((p) => `${p.name} ($${p.monthly}/mo, or $${p.annualPerMonth}/mo billed annually)`)
    .join(", ");

  return `# Paralegix

> Paralegix is a cloud-based legal practice management platform for law firms. It unifies matter (case) intake, documents, calendaring, time tracking, trust accounting, and billing into one workspace, with a secure client portal. Paralegix is a software tool, not a law firm, and does not provide legal advice.

## Product

- [Home](${SITE_URL}/): Product overview - matter management, document automation, billing & trust accounting, calendaring, and security.
- [Features](${SITE_URL}/features): Full breakdown of every module: document automation, matter management, time/billing/trust, deadlines & calendar, client portal & intake, reporting, and security.
- [Workflow](${SITE_URL}/workflow): How a single matter moves through Paralegix end to end, from client intake to final invoice.
- [Pricing](${SITE_URL}/pricing): Plans - Starter (free) and ${paid}. Includes a full feature comparison table and pricing FAQ.

## Get started

- [Create an account](${SITE_URL}/register): Free Starter plan, no credit card required.
- [Sign in](${SITE_URL}/login): For existing firm members and clients.

## Legal

- [Terms of Service](${SITE_URL}/terms)
- [Privacy Policy](${SITE_URL}/privacy)
- [Sub-processors](${SITE_URL}/subprocessors): Third-party vendors that process personal data on Paralegix's behalf.

## Optional

- [Full reference](${SITE_URL}/llms-full.txt): Every feature, plan detail, FAQ answer, and workflow stage in one file, for deeper crawling.
`;
}

function buildNonCanonicalStub(): string {
  return `# Paralegix (non-canonical deployment)

> This deployment is not the canonical Paralegix site and is not intended to be indexed or cited. See the canonical file instead.

- [Canonical llms.txt](${SITE_URL}/llms.txt)
`;
}

export function GET() {
  const body = IS_INDEXABLE ? buildLlmsTxt() : buildNonCanonicalStub();
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
