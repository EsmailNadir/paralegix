import LegalPageHeader from "@/components/ui/LegalPageHeader";
import LegalPageFooter from "@/components/ui/LegalPageFooter";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structuredData";

export const metadata = {
  title: "Terms of Service",
  description: "Terms of Service for Paralegix legal practice management platform.",
  alternates: { canonical: "/terms" },
};

export default function TermsOfService() {
  return (
    <div className="min-h-screen bg-surface-alt">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          ...breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Terms of Service", path: "/terms" },
          ]),
        }}
      />
      <LegalPageHeader />

      {/* Content */}
      <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-surface rounded-xl border border-outline p-8 sm:p-12">
          <h1 className="text-3xl font-bold text-on-surface mb-2">Terms of Service</h1>
          <p className="text-sm text-on-surface-muted mb-10">Last updated: September 22, 2026</p>

          <div className="space-y-8 text-sm text-on-surface-secondary leading-relaxed">
            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">1. Acceptance of Terms</h2>
              <p>
                By accessing or using Paralegix (&quot;the Service&quot;), operated by Paralegix Inc. (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;), you agree to be bound by these Terms of Service. If you do not agree to these terms, do not use the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">2. Description of Service</h2>
              <p>
                Paralegix is a cloud-based legal practice management platform that provides tools for matter management, task tracking, time entries, billing, document management, calendar scheduling, client communication, and analytics. The Service is designed for law firms and their clients.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">3. Account Registration</h2>
              <p className="mb-3">By creating an account, you represent that:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>You are at least 18 years of age.</li>
                <li>You, or the law firm you use the Service with, are located in the United States. The Service is not offered to businesses or consumers in Canada, including Quebec.</li>
                <li>The information you provide is accurate, complete, and current.</li>
                <li>You will maintain the security of your account credentials.</li>
                <li>You are responsible for all activity that occurs under your account.</li>
                <li>You will notify us immediately of any unauthorized use of your account.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">4. User Types</h2>
              <p className="mb-3">The Service supports two primary user types:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Law Firm Members:</strong> Attorneys, paralegals, and staff who manage matters, tasks, billing, and client relationships within a law firm account.</li>
                <li><strong className="text-on-surface">Clients:</strong> Individuals or entities who access the client portal to view matter information, communicate with their legal team, and review billing.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">5. Acceptable Use</h2>
              <p className="mb-3">You agree not to:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>Use the Service for any unlawful purpose or in violation of any applicable laws or regulations.</li>
                <li>Upload, transmit, or store any content that is harmful, threatening, abusive, defamatory, or otherwise objectionable.</li>
                <li>Attempt to gain unauthorized access to the Service, other accounts, or any related systems or networks.</li>
                <li>Interfere with or disrupt the integrity or performance of the Service.</li>
                <li>Reverse engineer, decompile, or disassemble any part of the Service.</li>
                <li>Use automated systems (bots, scrapers, etc.) to access the Service without prior written consent.</li>
                <li>Share your account credentials with third parties or allow others to access the Service through your account.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">6. Data Ownership and Content</h2>
              <p className="mb-3">
                You retain ownership of all data, documents, and content you upload or create using the Service (&quot;Your Content&quot;). By using the Service, you grant us a limited license to process, store, and display Your Content solely for the purpose of providing the Service to you.
              </p>
              <p className="mb-3">
                We do not claim any ownership rights over Your Content. Upon termination of your account, you may request an export of Your Content in accordance with our data export procedures.
              </p>
              <p className="mb-3">
                We collect usage data about how the Service is used, such as which features are opened and when, to operate, secure and improve it. Usage data never includes Your Content, and we handle it as described in our Privacy Policy.
              </p>
              <p>
                Where the Service is used by a law firm, the law firm (our customer) is the controller of its clients&apos; data and decides how that data is used. Paralegix acts as a processor and handles that data only on the law firm&apos;s behalf and in accordance with its instructions and these Terms. Account, usage and product analytics data about the people who use the Service, including client-portal users, is controlled by Paralegix and handled as described in our Privacy Policy.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">7. Confidentiality</h2>
              <p>
                We understand that legal data is highly sensitive. We implement appropriate technical and organizational measures to protect the confidentiality of Your Content, including attorney-client privileged information. We will not access, use, or disclose Your Content except as necessary to provide the Service, comply with applicable law, or respond to a valid legal process.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">8. Payment and Billing</h2>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>Paid features are billed in accordance with the pricing plan selected at the time of subscription.</li>
                <li><strong className="text-on-surface">Automatic renewal.</strong> Subscriptions renew automatically at the end of each billing period, monthly or annually, at the then-current price for your plan. We charge the payment method on file until you cancel.</li>
                <li><strong className="text-on-surface">How to cancel.</strong> Cancel at any time from Settings, then Billing, in the same account you used to subscribe. Cancellation takes no more steps than signing up took, and needs no phone call or email. You can also cancel through the Stripe billing portal linked on the same page.</li>
                <li><strong className="text-on-surface">Effect of cancellation.</strong> Cancellation stops the next renewal charge. Your plan stays active for the rest of the period you already paid for. After that the workspace is paused, your firm&apos;s data is retained, and you can reactivate by choosing a plan.</li>
                <li>All fees are non-refundable unless otherwise stated in your subscription agreement.</li>
                <li>We reserve the right to modify pricing with 30 days&apos; prior notice. A price change takes effect at your next renewal.</li>
                <li>Failure to pay may result in suspension or termination of access to the Service.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">9. Service Availability</h2>
              <p>
                We strive to maintain high availability of the Service but do not guarantee uninterrupted or error-free operation. We may perform scheduled maintenance, deploy updates, or experience unforeseen outages. We will make reasonable efforts to notify users of planned downtime in advance.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">10. Limitation of Liability</h2>
              <p className="mb-3">
                To the maximum extent permitted by applicable law, Paralegix Inc. and its officers, directors, employees, and agents shall not be liable for:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>Any indirect, incidental, special, consequential, or punitive damages.</li>
                <li>Loss of data, profits, revenue, or business opportunities.</li>
                <li>Any damages arising from your reliance on the Service for legal decisions or advice.</li>
              </ul>
              <p className="mt-3">
                You are solely responsible for the legal decisions made using information managed through the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">11. Not Legal Advice</h2>
              <p className="mb-3">
                Paralegix is a software tool, not a law firm. We do not provide legal advice and do not practice law. No attorney-client relationship is created by your use of the Service.
              </p>
              <p>
                Any outputs generated through the Service, including assembled documents and templates, are provided for convenience only and are not a substitute for the professional judgment of a licensed attorney. The law firm remains solely responsible for its own clients&apos; matters, for reviewing any output before use, and for ensuring that its use of the Service complies with applicable laws and professional responsibility rules.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">12. Indemnification</h2>
              <p>
                You agree to indemnify and hold harmless Paralegix Inc. from any claims, damages, losses, liabilities, and expenses (including reasonable attorney&apos;s fees) arising from your use of the Service, your violation of these Terms, or your violation of any rights of a third party.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">13. Termination</h2>
              <p className="mb-3">
                Either party may terminate your account at any time. We may suspend or terminate access to the Service immediately, without prior notice, if:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>You breach these Terms of Service.</li>
                <li>We are required to do so by law.</li>
                <li>Your use poses a security risk to the Service or other users.</li>
              </ul>
              <p className="mt-3">
                Upon termination, your right to use the Service will immediately cease. Provisions that by their nature should survive termination will survive, including ownership, warranty disclaimers, indemnification, and limitations of liability.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">14. Modifications to Terms</h2>
              <p>
                We may modify these Terms from time to time. Before a material change takes effect, we will notify you by email or through the Service at least 30 days in advance. Material changes apply to you only once you accept them; if you do not, you may stop using the Service and cancel under Section 8 before the change takes effect. Changes that are not material, such as corrections or clarifications, take effect when posted.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">15. Governing Law</h2>
              <p>
                These Terms shall be governed by and construed in accordance with the laws of the jurisdiction in which Paralegix Inc. is incorporated, without regard to its conflict of law provisions.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">16. Contact Us</h2>
              <p>
                If you have any questions about these Terms of Service, please contact us at{" "}
                <a href="mailto:contact@paralegix.com" className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors">
                  contact@paralegix.com
                </a>.
              </p>
            </section>
          </div>
        </div>

        <LegalPageFooter currentPage="terms" />
      </main>
    </div>
  );
}
