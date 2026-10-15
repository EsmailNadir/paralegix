import LegalPageHeader from "@/components/ui/LegalPageHeader";
import LegalPageFooter from "@/components/ui/LegalPageFooter";
import JsonLd from "@/components/marketingComp/JsonLd";
import { breadcrumbSchema } from "@/lib/seo/structuredData";
import CookieSettingsLink from "@/components/ui/CookieSettingsLink";

export const metadata = {
  title: "Privacy Policy",
  description: "Privacy Policy for Paralegix legal practice management platform.",
  alternates: { canonical: "/privacy" },
};

export default function PrivacyPolicy() {
  return (
    <div className="min-h-screen bg-surface-alt">
      <JsonLd
        data={{
          "@context": "https://schema.org",
          ...breadcrumbSchema([
            { name: "Home", path: "/" },
            { name: "Privacy Policy", path: "/privacy" },
          ]),
        }}
      />
      <LegalPageHeader />

      {/* Content */}
      <main id="main-content" tabIndex={-1} className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="bg-surface rounded-xl border border-outline p-8 sm:p-12">
          <h1 className="text-3xl font-bold text-on-surface mb-2">Privacy Policy</h1>
          <p className="text-sm text-on-surface-muted mb-10">Last updated: September 22, 2026</p>

          <div className="space-y-8 text-sm text-on-surface-secondary leading-relaxed">
            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">1. Introduction</h2>
              <p>
                Paralegix Inc. (&quot;we&quot;, &quot;us&quot;, or &quot;our&quot;) is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use the Paralegix platform (&quot;the Service&quot;). We understand that legal data requires the highest standards of privacy and security.
              </p>
              <p className="mt-3">
                The Service is offered to law firms in the United States and their clients. It is not
                offered to businesses or consumers in Canada, including Quebec.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">2. Information We Collect</h2>

              <h3 className="text-base font-medium text-on-surface mt-4 mb-2">2.1 Information You Provide</h3>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Account Information:</strong> Name, email address, password, user type (law firm member or client), and law firm affiliation.</li>
                <li><strong className="text-on-surface">Profile Information:</strong> Professional title, contact details, and profile preferences.</li>
                <li><strong className="text-on-surface">Matter Data:</strong> Matter details, client information, notes, time entries, documents, invoices, and other content you create or upload through the Service.</li>
                <li><strong className="text-on-surface">Communications:</strong> Messages exchanged through the platform&apos;s messaging system between law firm members and clients.</li>
                <li><strong className="text-on-surface">Calendar Data:</strong> Events, deadlines, and scheduling information, including data synced from Google Calendar or Microsoft Outlook.</li>
                <li><strong className="text-on-surface">Billing and Payment Data:</strong> Invoices, time entries, expenses, and payment records. Card details are entered directly with Stripe and never reach our servers. For firms that use trust accounting, we store the bank name, the last four digits of the account and routing numbers, and the tax identification number of an IOLTA account.</li>
                <li><strong className="text-on-surface">Contacts and Third-Party Details:</strong> Names, email addresses, phone numbers, and other details a firm records about contacts, leads, opposing parties, and conflict-check subjects. These people are not users of the Service.</li>
                <li><strong className="text-on-surface">Intake and Document Requests:</strong> Answers submitted through a firm&apos;s intake form, and files uploaded in response to a document request, including submissions from prospective clients who never create an account.</li>
                <li><strong className="text-on-surface">Electronic Signature Data:</strong> The signature image you draw or type, the name and email address of each participant, and a signing audit trail that records each action with its time, IP address, and browser user agent. This audit trail is evidence of signing and cannot be altered after the fact.</li>
                <li><strong className="text-on-surface">Consent Records:</strong> When you accept these terms, we record the time of acceptance, the policy version, and the IP address the acceptance came from.</li>
              </ul>

              <h3 className="text-base font-medium text-on-surface mt-4 mb-2">2.2 Information Collected Automatically</h3>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Usage Data:</strong> Pages visited, features used, timestamps, and interaction patterns, including any campaign parameters (such as utm tags) in the link you arrived by.</li>
                <li><strong className="text-on-surface">Device Information:</strong> Browser type, operating system, device type, and screen resolution.</li>
                <li><strong className="text-on-surface">Log Data:</strong> IP address, access times, and referring URLs.</li>
                <li><strong className="text-on-surface">Timezone Information:</strong> Your timezone is collected to ensure accurate display of dates, deadlines, and calendar events.</li>
                <li><strong className="text-on-surface">Audit and Security Logs:</strong> We record security-relevant actions with the acting user&apos;s identifier and email address, the request method and path, the response status, the IP address, and the browser user agent. These logs are append-only.</li>
                <li><strong className="text-on-surface">Document Access Records:</strong> When a client first opens a document shared through the portal, we record that first view so the firm can confirm the document was received.</li>
              </ul>

              <h3 className="text-base font-medium text-on-surface mt-4 mb-2">2.3 Third-Party Authentication</h3>
              <p>
                If you sign in using Google or Microsoft OAuth, we receive your name, email address, and profile picture from the respective provider. We do not receive or store your third-party account passwords.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">3. How We Use Your Information</h2>
              <p className="mb-3">We use the information we collect to:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>Provide, operate, and maintain the Service.</li>
                <li>Authenticate your identity and manage your account.</li>
                <li>Process and display matter information, tasks, time entries, and billing data.</li>
                <li>Facilitate communication between law firm members and clients.</li>
                <li>Synchronize calendar events with third-party calendar services (Google Calendar, Microsoft Outlook) when authorized by you.</li>
                <li>Send transactional emails (account verification, password resets, invitations, reminders, and billing notifications).</li>
                <li>Create and verify electronic signatures, including the audit trail that evidences each signing.</li>
                <li>Maintain security and audit logs, detect abuse, and enforce rate limits.</li>
                <li>Improve and maintain the Service using internal usage and error logs, and product analytics and error reports from PostHog that record which features are used and where the application failed. Analytics events carry account and record identifiers, never the contents of your matters, notes, messages, documents or invoices, and we do not record your screen or the text you click. PostHog does not store your IP address; it uses it only to derive an approximate location (country, region, city, postal code and approximate coordinates) before discarding it. We do not use any advertising product.</li>
                <li>Enforce our Terms of Service and protect against fraud or abuse.</li>
                <li>Comply with legal obligations.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">4. Legal Bases for Processing</h2>
              <p className="mb-3">
                If you are in the European Economic Area, the United Kingdom or Switzerland, we
                process your personal data on the following legal bases:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Contract:</strong> To provide the Service you or your law firm signed up for.</li>
                <li><strong className="text-on-surface">Legitimate Interests:</strong> To secure the Service, prevent abuse, keep audit records, maintain the platform, and understand which features are used so we can improve them. This covers the few account events our servers record, such as a firm being created or a subscription changing, which continue even if you decline analytics in your browser.</li>
                <li><strong className="text-on-surface">Consent:</strong> For optional features you turn on yourself, such as calendar synchronization, and for product analytics where the law of your region requires it.</li>
                <li><strong className="text-on-surface">Legal Obligation:</strong> To keep financial and trust accounting records, and to respond to lawful requests.</li>
              </ul>
              <p className="mt-3">
                We do not use your data to make automated decisions that produce legal effects, and
                we do not use it to train machine learning models.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">5. Data Storage and Security</h2>
              <p className="mb-3">
                Your application data is stored in a PostgreSQL database hosted on Supabase. Uploaded files and documents are stored in Google Cloud Storage. Our application server runs on Google Cloud Run and our web front end is hosted by Vercel. Authentication is managed through Firebase Authentication. We implement the following security measures:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>All data is encrypted in transit using TLS/SSL.</li>
                <li>Data at rest is encrypted using our infrastructure providers&apos; default encryption (Supabase and Google Cloud).</li>
                <li>Sign-in is handled by Firebase Authentication, using Google or Microsoft OAuth or an email address and password. We never see or store your password.</li>
                <li>Access controls enforce role-based permissions (firm members, clients, administrators), and every record is scoped to the law firm that owns it.</li>
                <li>Authenticated API endpoints verify an identity token on every request. A small number of endpoints are deliberately public so a recipient can act without an account: electronic signing links, file share links, and intake forms. Each of these is reached only through a secret single-use link and is rate limited.</li>
                <li>Security-relevant actions are written to an append-only audit log.</li>
              </ul>
              <p className="mt-3">
                Your personal data may be stored and processed in the United States or in other countries where our service providers operate. The specific database region is determined by our deployment configuration. Customers with regional data residency requirements should contact the law firm responsible for their data.
              </p>
              <p className="mt-3">
                While we implement commercially reasonable security measures, no method of electronic storage or transmission is 100% secure. We cannot guarantee absolute security of your data.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">6. Security Incidents</h2>
              <p>
                If we find a breach of security that affects your personal data, we will notify the
                affected law firm without undue delay, and we will notify individual users and
                regulators where the law requires it. Our notice will describe what happened, what
                data was involved, and what steps we are taking.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">7. Data Sharing and Disclosure</h2>
              <p className="mb-3">
                We do not sell your personal information, and we do not share it for cross-context
                behavioral advertising. Where a law firm uses the Service, that firm is the
                controller of the matter data it holds about its clients and decides how that data is
                used. Paralegix acts as a processor for that data and handles it only on the
                firm&apos;s behalf. Paralegix is the controller of account, usage and product
                analytics data about everyone who uses the Service, including client-portal users. If
                you are a client of a firm, direct requests about your matter data to that firm first.
              </p>
              <p className="mb-3">We may share your information in the following circumstances:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Within Your Organization:</strong> Law firm members within the same firm can access shared matter data, tasks, and client information as determined by the firm&apos;s access controls.</li>
                <li><strong className="text-on-surface">Between Firms and Clients:</strong> Matter information and messages are shared between law firm members and their clients through the client portal, as configured by the law firm.</li>
                <li><strong className="text-on-surface">Service Providers (Sub-processors):</strong> We use the following third-party services to host and operate the Service, each of which processes data on our behalf under contractual obligations to protect your information:
                  <ul className="list-[circle] pl-5 mt-1.5 space-y-1.5">
                    <li>Supabase, PostgreSQL database hosting.</li>
                    <li>Google Cloud Storage, file and document storage.</li>
                    <li>Google Cloud Run, application server hosting.</li>
                    <li>Firebase Authentication, sign-in and identity.</li>
                    <li>Stripe, payment processing.</li>
                    <li>Resend, transactional email delivery.</li>
                    <li>Vercel, frontend hosting.</li>
                    <li>PostHog, product analytics and error reports.</li>
                    <li>Google and Microsoft, optional calendar synchronization when you connect your calendar.</li>
                  </ul>
                  <p className="mt-1.5">
                    A full, current list is available on our{" "}
                    <a href="/subprocessors" className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors">
                      Sub-processors page
                    </a>.
                  </p>
                </li>
                <li><strong className="text-on-surface">Legal Requirements:</strong> We may disclose information if required by law, subpoena, court order, or governmental regulation.</li>
                <li><strong className="text-on-surface">Business Transfers:</strong> In the event of a merger, acquisition, or sale of assets, your information may be transferred as part of that transaction. We will notify you of any such change.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">8. Calendar Integration</h2>
              <p className="mb-3">
                When you connect Google Calendar or Microsoft Outlook to Paralegix:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>We access your calendar data only with your explicit authorization via OAuth.</li>
                <li>Calendar sync is used solely to create, update, and delete events related to your tasks and deadlines within the Service.</li>
                <li>You can disconnect calendar integrations at any time through your account settings.</li>
                <li>Disconnecting will stop future syncing but will not delete events already created in your external calendar.</li>
              </ul>
            </section>

            <section id="cookies" className="scroll-mt-24">
              <h2 className="text-lg font-semibold text-on-surface mb-3">9. Cookies and Local Storage</h2>
              <p className="mb-3">We use browser local storage and cookies for:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Authentication:</strong> Maintaining your login session via Firebase Authentication tokens.</li>
                <li><strong className="text-on-surface">Preferences:</strong> Storing your theme preference (light/dark mode) and dashboard widget configuration.</li>
                <li><strong className="text-on-surface">Performance:</strong> Caching certain data to reduce load times and API calls.</li>
                <li><strong className="text-on-surface">Documentation Access:</strong> A signed cookie that unlocks our documentation site for signed-in users.</li>
                <li><strong className="text-on-surface">Notice Acknowledgement:</strong> A local storage flag that records that you dismissed our cookie notice, so we do not show it again.</li>
                <li><strong className="text-on-surface">Product Analytics:</strong> A first-party cookie and local storage entry set by PostHog that lets us count how the Service is used across visits. It is served from our own domain and is not shared with advertisers.</li>
                <li><strong className="text-on-surface">Analytics Choice:</strong> A local storage entry that records whether you accepted or declined product analytics and when, so we can ask again after a year, and a session entry that records whether your region asks for that choice.</li>
              </ul>
              <p className="mt-3">
                If you are in the European Union, the European Economic Area, the United Kingdom,
                Switzerland or Canada, we ask before setting the analytics cookie, and analytics stays off
                unless you accept. Elsewhere, analytics starts when you visit and our cookie notice
                tells you so. Wherever you are, you can accept or decline at any time from{" "}
                <CookieSettingsLink className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors" />
                , which is also at the foot of our website and in the Privacy &amp; Your Data section of
                your account settings. We do not use advertising or cross-site tracking cookies.
              </p>
              <p className="mt-3">
                We do not respond to browser Do Not Track signals, because there is no common standard
                for them. No third party collects personal information about your activity across
                other websites through the Service.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">10. Email Communications</h2>
              <p className="mb-3">
                The Service sends transactional email: account verification, password resets,
                invitations, task and deadline reminders, signing requests, invoices, and payment
                receipts. We do not send marketing email.
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>Every message carries our postal address and a link to manage your email preferences.</li>
                <li>Every message sets a List-Unsubscribe header, which your mail client can use to opt out.</li>
                <li>Reminder and notification email can be turned off in your settings. A law firm can also turn off client payment email for its whole firm.</li>
                <li>Email that is required to operate your account, such as a password reset, is always sent.</li>
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">11. Your Rights</h2>
              <p className="mb-3">Depending on your jurisdiction, you may have the following rights:</p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Access:</strong> Request a copy of the personal data we hold about you.</li>
                <li><strong className="text-on-surface">Correction:</strong> Request correction of inaccurate or incomplete personal data.</li>
                <li><strong className="text-on-surface">Deletion:</strong> Request deletion of your personal data, subject to legal retention requirements.</li>
                <li><strong className="text-on-surface">Data Portability:</strong> Request an export of your data in a machine-readable format.</li>
                <li><strong className="text-on-surface">Restriction:</strong> Ask us to limit how we use your personal data while a concern about it is resolved.</li>
                <li><strong className="text-on-surface">Objection:</strong> Object to the processing of your personal data for certain purposes.</li>
                <li><strong className="text-on-surface">Withdrawal of Consent:</strong> Withdraw consent for data processing where consent is the legal basis.</li>
                <li><strong className="text-on-surface">Complaint:</strong> Lodge a complaint with your local data protection authority.</li>
              </ul>
              <p className="mt-3">
                You can exercise access, portability and deletion yourself. Open your account settings
                and use the Privacy section to download a machine-readable copy of your personal data,
                or to delete your account. Two limits apply to self-service deletion. If you own a law
                firm, transfer or delete that firm first, otherwise the firm would be left without
                an owner. If you are a client with trust-account activity or billing history, your
                firm must archive you instead, because deleting you would destroy financial records
                the firm is required to keep.
              </p>
              <p className="mt-3">
                For every other request, or if you are a client of a law firm, contact that firm.
                The firm can compile and export your data from within the Service. You can also
                contact us at{" "}
                <a href="mailto:contact@paralegix.com" className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors">
                  contact@paralegix.com
                </a>.
              </p>
              <p className="mt-3">
                You can turn off the product analytics collected in your browser yourself, from
                Cookie settings. A few account events, such as creating a firm or a change to a
                subscription, are recorded by our servers rather than your browser, so they continue
                after you decline. Deleting your account deletes your analytics data with it. To have it
                deleted while keeping your account, including those events, email us at the same address.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">12. Data Retention</h2>
              <p className="mb-3">
                We retain your data for as long as your account is active or as needed to provide
                the Service. Law firms are responsible for managing retention of matter-related
                data in accordance with applicable legal and professional obligations.
              </p>
              <p className="mb-3">
                If an account is created with an email address and that address is never verified,
                we delete the account and the address within seven days. This applies whether you
                started a signup and abandoned it, or someone else entered your address without
                your knowledge.
              </p>
              <p className="mb-3">
                When you delete your account, we anonymize your record immediately and delete your
                sign-in identity, along with your profile picture. We keep the anonymized record so
                that references to it elsewhere in a firm&apos;s files stay valid. We also ask PostHog to
                delete your product analytics data, which it removes shortly after. Three categories of
                data survive account deletion by design:
              </p>
              <ul className="list-disc pl-5 space-y-1.5">
                <li><strong className="text-on-surface">Trust accounting entries,</strong> which are append-only and cannot be edited or removed. They can only be adjusted by a later reversing entry.</li>
                <li><strong className="text-on-surface">Audit and security logs,</strong> which are append-only and retain the acting user&apos;s identifier.</li>
                <li><strong className="text-on-surface">Signing audit trails,</strong> which are the evidence that a document was signed.</li>
                
              </ul>
              <p className="mt-3">
                When a law firm closes its account, we immediately revoke access, cancel its
                subscription, and stop its calendar sync. We then retain the firm&apos;s data for a
                retention period, ten years by default, because state bar rules commonly require
                client files to be kept for five to ten years. After that period, an automated job
                permanently deletes the firm and all of its records and files.
              </p>
              <p className="mt-3">
                Product analytics events are kept by PostHog for one year. If that period ever grows,
                we will update this policy before it does. We delete them sooner when you ask us to.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">13. Children&apos;s Privacy</h2>
              <p>
                The Service is not intended for individuals under the age of 18. We do not knowingly collect personal information from children. If you become aware that a child has provided us with personal data, please contact us and we will take steps to delete such information.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">14. International Data Transfers</h2>
              <p>
                We are based in the United States, and your data is stored and processed there and in other countries where our service providers operate, which may have different data protection laws than your country of residence. If you use the Service from outside the United States, the personal data you give us is collected directly in the United States. When our service providers receive personal data that originated in the European Economic Area, the United Kingdom or Switzerland, we rely on their certification under the EU-U.S. Data Privacy Framework (and its UK and Swiss extensions) or on the European Commission&apos;s Standard Contractual Clauses. Data held in the United States may be accessible to courts and authorities there under United States law. Contact us for a copy of the safeguards that apply.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">15. Changes to This Policy</h2>
              <p>
                We may update this Privacy Policy from time to time, and we post every version on this page with its &quot;Last updated&quot; date. Before a material change takes effect, we will email you and give at least 30 days&apos; notice. Where a change needs your consent, such as using data you have already given us in a new way, we will ask for it rather than treat continued use as agreement.
              </p>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-on-surface mb-3">16. Contact Us</h2>
              <p>
                If you have any questions or concerns about this Privacy Policy or our data practices, please contact us at{" "}
                <a href="mailto:contact@paralegix.com" className="text-accent-emphasis hover:text-accent-emphasis-hover font-medium transition-colors">
                  contact@paralegix.com
                </a>.
              </p>
            </section>
          </div>
        </div>

        <LegalPageFooter currentPage="privacy" />
      </main>
    </div>
  );
}
