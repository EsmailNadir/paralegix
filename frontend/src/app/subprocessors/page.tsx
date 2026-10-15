import LegalPageHeader from "@/components/ui/LegalPageHeader";
import LegalPageFooter from "@/components/ui/LegalPageFooter";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structuredData";

export const metadata = {
  title: "Sub-processors",
  description: "Third-party sub-processors that process personal data for the Paralegix platform.",
  alternates: { canonical: "/subprocessors" },
};

interface Subprocessor {
  name: string;
  purpose: string;
  region: string;
}

const subprocessors: Subprocessor[] = [
  {
    name: "Supabase",
    purpose: "PostgreSQL database hosting for application data.",
    region: "Region per project configuration.",
  },
  {
    name: "Google Cloud Storage",
    purpose: "File and document storage.",
    region: "Region per project configuration.",
  },
  {
    name: "Google Cloud Run",
    purpose: "Application server hosting.",
    region: "Region per project configuration.",
  },
  {
    name: "Firebase Authentication",
    purpose: "Sign-in and identity.",
    region: "Operated by Google in the United States and other regions.",
  },
  {
    name: "Stripe",
    purpose: "Payment processing.",
    region: "Operated in the United States and other regions.",
  },
  {
    name: "Resend",
    purpose: "Transactional email delivery.",
    region: "Operated in the United States and other regions.",
  },
  {
    name: "Vercel",
    purpose: "Frontend hosting.",
    region: "Operated in the United States and other regions.",
  },
  {
    name: "PostHog",
    purpose: "Product analytics and error monitoring. Receives account and record identifiers and usage events, not matter, note, message or document contents.",
    region: "Operated in the United States.",
  },
  {
    name: "Google and Microsoft",
    purpose: "Optional calendar sync, used only when a user connects their calendar.",
    region: "Operated in the United States and other regions.",
  },
];

export default function Subprocessors() {
  return (
    <div className="min-h-screen bg-surface-alt">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          ...breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Sub-processors", path: "/subprocessors" },
          ]),
        }}
      />
      <LegalPageHeader />

      {/* Content */}
      <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-surface rounded-xl border border-outline p-8 sm:p-12">
          <h1 className="text-3xl font-bold text-on-surface mb-2">Sub-processors</h1>
          <p className="text-sm text-on-surface-muted mb-10">Last updated: September 22, 2026</p>

          <div className="space-y-8 text-sm text-on-surface-secondary leading-relaxed">
            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">Overview</h2>
              <p className="mb-3">
                To provide the Paralegix platform (&quot;the Service&quot;), we engage the third-party
                sub-processors listed below. Each one processes personal data on our behalf under
                contractual obligations to protect that data. This list may change as we add,
                replace, or remove providers, and we will update this page accordingly.
              </p>
              <p>
                Where the Service is used by a law firm, the law firm (our customer) is the data
                controller for its clients&apos; data and decides how that data is used. Paralegix and
                these sub-processors act as processors, handling that data only on the firm&apos;s behalf.
                For account, usage and product analytics data about the people who use the Service,
                Paralegix is the controller and the providers below, such as PostHog, act as its
                processors.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">Current Sub-processors</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-outline">
                      <th scope="col" className="py-2 pr-4 font-semibold text-on-surface">Name</th>
                      <th scope="col" className="py-2 pr-4 font-semibold text-on-surface">Purpose</th>
                      <th scope="col" className="py-2 font-semibold text-on-surface">Region note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subprocessors.map((sub) => (
                      <tr key={sub.name} className="border-b border-outline-subtle align-top">
                        <td className="py-3 pr-4 font-medium text-on-surface whitespace-nowrap">{sub.name}</td>
                        <td className="py-3 pr-4">{sub.purpose}</td>
                        <td className="py-3">{sub.region}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">Questions</h2>
              <p>
                If you have any questions about our sub-processors or our data practices, please
                contact us at{" "}
                <a href="mailto:contact@paralegix.com" className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors">
                  contact@paralegix.com
                </a>.
              </p>
            </section>
          </div>
        </div>

        <LegalPageFooter currentPage="subprocessors" />
      </main>
    </div>
  );
}
