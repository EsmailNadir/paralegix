# Client and public accessibility audit

This is a source inventory and implementation tracker, not a conformance report. No browser or manual screen-reader review has been performed. Direct UI imports identify the next review boundaries; they are not a claim that the complete transitive component tree has been audited.

## Implemented foundation

| Barrier | Source | Regression | Relevant criteria |
|---|---|---|---|
| Destination navigation exposed as buttons | MarketingNav, MarketingFooter, marketing Btn | MarketingAccessibility.test.tsx: named links and real hrefs | 1.3.1, 4.1.2 |
| Collapsed FAQ content remains exposed | PricingFaq | MarketingAccessibility.test.tsx: open, change, and collapse answer | 1.3.1, 4.1.2 |
| Billing interval lacks selected state | PricingPlans | MarketingAccessibility.test.tsx: keyboard interval change, prices and announcement | 4.1.2, 4.1.3 |
| Skip link does not move focus; marketing has no skip link | SkipLink, MarketingTransition, ClientLayoutClient | SkipLink.test.tsx and client layout integration | 2.4.1, 2.4.3 |
| Offscreen client drawer remains available | ClientSidebar | ClientSidebarAccessibility.test.tsx: inert closed drawer | 2.4.3, 4.1.2 |
| Client drawer has no focus trap/restoration | ClientSidebar, existing useDialog | ClientSidebarAccessibility.test.tsx: open, wrap, Escape, restore, resize | 2.1.1, 2.1.2, 2.4.3 |
| Client account popup escapes drawer focus trap | ClientSidebar, ItemActionMenu portal destination | ClientSidebarAccessibility.test.tsx: keyboard reaches sign out | 2.1.1, 2.4.3 |
| Client route changes lose keyboard position | ClientLayoutClient | ClientLayoutClient.test.tsx: destination focus, stable focus on updates | 2.4.3 |
| Closing marketing menu retains available controls | MarketingNav | MarketingNavigationExit.test.tsx: real animation DOM is inert/hidden | 2.4.3 |
| Marketing entrance ignores reduced motion | MarketingTransition | MarketingMotion.test.tsx: content visible immediately, no transform | Preference support; broader motion criteria still need review |

The axe helper returns the entire result, including incomplete checks. It checks WCAG A/AA DOM rules; contrast is disabled only because jsdom cannot measure layout. Contrast and other visual criteria remain pending. The helper's regression seeds an unlabeled input and proves it reports the violation before associating the label.

## Implemented client entry feedback

| Barrier | Source | Regression | Relevant criteria |
|---|---|---|---|
| Recovery action excluded from Tab; replacement form loses focus | LoginClient | LoginClient.test.tsx: keyboard recovery, return focus, email-sent status | 2.1.1, 2.4.3, 4.1.3 |
| Authentication failures have no focused summary | LoginClient, useFormFeedback | LoginClient.test.tsx: failed sign-in summary focus and credential descriptions | 2.4.3, 3.3.1 |
| Recovery network failure incorrectly identifies the email as invalid | LoginClient | LoginClient.test.tsx: real submitted email, request rejection, summary focus and valid email | 3.3.1 |
| Invitation password toggles excluded from Tab | Client/member invitation registration | RegisterInvitations.test.tsx: keyboard reaches and activates both toggles | 2.1.1 |
| Password errors do not describe or focus the affected input | useInvitationCredentials, reset-password, useFormFeedback | RegisterInvitations.test.tsx and ResetPasswordAccessibility.test.tsx: repeated failures, descriptions, invalid state, retry; provider weak-password mutation fails | 1.3.1, 2.4.3, 3.3.1, 3.3.3 |
| Acceptance refusal leaves focus on the submitting button | AcceptInvitePageClient | AcceptInvitations.test.tsx: repeated refusals and successful retry through transport | 2.4.3, 3.3.1 |
| Verification resend feedback is not announced | verify-email, auth/action | VerifyEmailAccessibility.test.tsx and AuthAction.test.tsx: success status, failure alert, cooldown excluded from live feedback | 4.1.3 |
| Manual verification failure and successful result have no focus destination | verify-email, reset-password, auth/action | Verification/reset/auth tests: failed check focus and success heading focus before redirect | 2.4.3 |
| Standalone entry forms lack a main landmark/page heading | Invitation registration, reset-password, verify-email | Registration/reset/verification tests: main contains the level-one heading | 1.3.1, 2.4.1, 2.4.6 |

Verification: 6 focused suites and 6 related suites passed (57 tests in each selection), `npm run ci:checks` passed with existing warnings/no lint errors, `npm run build` passed, and `git diff --check` passed. The UI heuristic guard has one reviewed finding for the existing reset-password auth link; its exit code is 1, not a clean pass.

These checks cover the listed interactions only. Initial/expired-link status screens, native browser validation, dismissal focus, polling-related redirects and redirect timing still need broader state and manual review. The existing three-second success redirects and verification cooldown are preserved, not certified as accessible. Public general signup and account/complete-registration remain pending.

## Implemented account and portal destinations

| Barrier | Source | Regression | Relevant criteria |
|---|---|---|---|
| Account skip link does not move keyboard focus | AccountLayoutClient, shared SkipLink | AccountLayoutAccessibility.test.tsx: skip activation, main focus, next control | 2.4.1, 2.4.3 |
| Name editor lacks native submission, instructions and focus destinations | ProfileNameSection, useFormFeedback | ProfileNameAccessibility.test.tsx: Enter submits through real auth service, hint/required state, cancel/save/error focus | 1.3.1, 2.4.3, 3.3.2 |
| Saved profile name is overwritten by an unchanged profile snapshot | ProfileNameSection | ProfileNameAccessibility.test.tsx: reopen after successful PUT still has the saved name | Workflow correctness |
| Shared Button omits the native ref from its types | Button | Button.test.tsx: native element identity and focus through ref; typecheck | Supports focus restoration |
| Matter cards are pointer-only and search has no name | ClientMattersPage, NavigationLink | ClientMattersAccessibility.test.tsx: named destination keyboard activation, scoped content, label, count announcement, clear-search focus, DOM scan | 1.3.1, 2.1.1, 2.4.3, 4.1.2, 4.1.3 |
| Dashboard destinations are pointer-only or ambiguous across firms | ClientDashboard, NavigationLink | ClientDashboardAccessibility.test.tsx: summary keyboard activation, named per-firm links, multiple-firm and paused-firm totals | 2.1.1, 2.4.4, 4.1.2 |
| Destination controls do not preserve native link affordances | NavigationLink | NavigationLink.test.tsx: real href, Enter, modified clicks, target/download handling and cancellation | 2.1.1, 4.1.2 |

Verification: 6 focused suites passed (31 tests), 6 related suites passed (24 tests), `npm run ci:checks` and `npm run build` passed, and `git diff --check` passed. The UI heuristic guard reports unchanged auth redirects and the existing dashboard unread badge; these were reviewed, and its exit code of 1 is not recorded as a clean pass.

These are destination/editor checks, not a full audit of dashboard/matter/account workflows. Visual focus visibility, page reflow and manual screen-reader behavior still need review. Card styles and the existing global focus indicator are preserved.

## Implemented public signup feedback

| Barrier | Source | Regression | Relevant criteria |
|---|---|---|---|
| Password visibility controls excluded from Tab; requirements only in a placeholder | RegisterClient | RegisterAccessibility.test.tsx: keyboard reaches and activates both visibility controls, selected state and persistent instructions; restoring the old Tab behavior fails | 2.1.1, 3.3.2, 4.1.2 |
| Password validation and provider field errors lack associations/focus | RegisterClient, useFormFeedback | RegisterAccessibility.test.tsx: repeated mismatch/length failures, weak-password/email rejection, corrected submissions through real auth/privacy transport and verification | 1.3.1, 2.4.3, 3.3.1 |
| Backend refusal has no focus destination; dismissing feedback loses focus | RegisterClient | RegisterAccessibility.test.tsx: actual backend refusal and Firebase rollback, summary focus, valid-field state, dismissal focus and preserved form values | 2.4.3, 3.3.1 |
| Signup heading is level two; destination controls are buttons | RegisterClient, SignupConsent | RegisterAccessibility.test.tsx and SignupConsent.test.tsx: level-one heading, actual hrefs, keyboard navigation callbacks and modified clicks | 2.4.4, 2.4.6, 4.1.2 |

Focused checks: `npx jest tests/app/register/RegisterAccessibility.test.tsx tests/components/ui/SignupConsent.test.tsx --runInBand` (11 tests), related-test selection (21 tests), `npm run ci:checks`, and `npm run build` pass. The UI heuristic reports two semantic auth link imports, permitted by the documented navigation exception; its exit code is 1.

OAuth popup failures/cancellation, signed-in redirects, native browser validation, visual focus/reflow and manual screen-reader checks remain pending. This slice preserves public signup's firm-member enrollment behavior and client invitation enrollment.

## Implemented complete-registration feedback

| Barrier | Source | Regression | Relevant criteria |
|---|---|---|---|
| Initial status lacks a landmark and named workflow announcement; form appears without focus destination | complete-registration | CompleteRegistrationAccessibility.test.tsx: held real profile read, checking status, main/heading, heading focus and next Tab; removing heading focus fails | 1.3.1, 2.4.3, 2.4.6, 4.1.3 |
| Registration refusals leave focus on submit; dismissal loses keyboard position | complete-registration, useFormFeedback | CompleteRegistrationAccessibility.test.tsx: repeated real 403 refusals, summary focus, dismissal focus and successful keyboard retry with exact token/type payload, terms recording and dashboard redirect | 2.4.3, 3.3.1 |
| Completion progress only changes the button text | complete-registration | CompleteRegistrationAccessibility.test.tsx: held registration write, persistent status announcement, disabled submit and preserved workspace content, then actual completion | 4.1.3 |

Focused and related Jest selections each pass the same 6 tests. `npm run ci:checks`, `npm run build`, and `git diff --check` pass. The UI heuristic flags only unchanged auth redirects; its exit code is 1 and the findings match the documented onboarding exception.

Initial profile errors, polling exhaustion, identity changes during requests, visual reflow/focus and manual screen-reader behavior remain pending. Existing firm-member enrollment, profile polling and registered client/member destinations are preserved.

## Implemented account photo and cropping

| Barrier | Source | Regression | Relevant criteria |
|---|---|---|---|
| Crop position/corners only respond to dragging; abbreviated corner names | LogoCropModal | LogoCropAccessibility.test.tsx: keyboard move and all corners, actual canvas source coordinates, scaled previews, bounds/minimum size and reset announcements; zero-distance keyboard mutation fails | 2.1.1, 4.1.2, 4.1.3 |
| Upload/removal errors appear behind the open dialog | ProfilePhotoSection, LogoCropModal | ProfilePhotoAccessibility.test.tsx: real refusal inside crop/confirmation, summary focus, storage retry/finalize, updated avatar and focus after upload/removal | 2.4.3, 3.3.1 |
| Invalid file feedback lacks focus; dialog cancellation breaks later validation focus | ProfilePhotoSection | ProfilePhotoAccessibility.test.tsx: invalid file summary/dismissal and refused-removal cancellation followed by new invalid-file feedback | 2.4.3, 3.3.1 |
| Canvas retry keeps a stale error; Reset Crop keeps stale announced coordinates | LogoCropModal | LogoCropAccessibility.test.tsx: repeated canvas refusal and real canvas retry before asserting alert removal; reset announcement agrees with exported geometry | 3.3.1, 4.1.3 |

Focused Jest selection passes 12 tests; related selection passes 17 tests across 4 suites. `npm run ci:checks`, `npm run build`, final typecheck, targeted test/helper lint and `git diff --check` pass. Keyboard regressions prove Tab reaches the move area and first corner within the real dialog. The UI heuristic flags existing crop masks/corner colors; its exit code is 1, not a clean pass.

Privacy controls remain next. Image decode/oversize errors, upload progress/timing, crop viewport resizing and manual screen-reader/visual checks remain open. These tests fake browser image/canvas decoding and geometry, so actual image presentation still needs manual review. Existing upload formats, output limits and success-message timing are preserved.

## Route inventory

Every route below needs populated, loading, empty, error, denied, expired-link and success states checked where applicable. Shared layouts and status components also need coverage. The first batch fixes shared navigation; it does not mark these page workflows complete.

| Route | Owner file | Direct UI boundaries | State |
|---|---|---|---|
| `/accept-invite` | `frontend/src/app/accept-invite/page.tsx` | `./AcceptInvitePageClient` | Repeated refusal focus and retry regressions pass; full state/manual review pending |
| `/account` | `frontend/src/app/account/page.tsx` | `@/components/ui/PageHeader`, `@/components/settingsComp/ProfilePhotoSection`, `@/components/settingsComp/ProfileNameSection`, `@/components/settingsComp/FirmMembershipSection`, `@/components/settingsComp/AccountPrivacySection` | Skip link, name editor, photo crop/upload/removal, privacy export/delete modal, and cookie preferences covered; visual/manual review pending |
| `/auth/action` | `frontend/src/app/auth/action/page.tsx` | `@/components/ui/ParalegixLogo`, `@/components/LoadingSpinner`, `@/components/ui/AuthButton`, `@/components/ui/InvalidLinkPage` | Resend announcements and success focus regressions pass; full state/manual review pending |
| `/client/dashboard` | `frontend/src/app/client/dashboard/page.tsx` | `@/components/LoadingSpinner`, `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/Card`, `@/components/ui/SectionLabel` | Named destination keyboard navigation and aggregate totals covered; full state/manual review pending |
| `/client/lawfirm/[lawFirmId]/billing/[invoiceId]` | `frontend/src/app/client/lawfirm/[lawFirmId]/billing/[invoiceId]/page.tsx` | `@/components/LoadingSpinner`, `@/components/ui/BackButton`, `@/components/ui/ListPager`, `@/components/billingComp/InvoicePDFDocument`, `@/components/billingComp/utils`, `@/components/ui/Modal`, `@/components/ui/StatusBadge`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/Card`, `@/components/ui/SectionLabel` | Invoice detail panel, payment history, back navigation, status badges covered (`ClientInvoiceAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/billing` | `frontend/src/app/client/lawfirm/[lawFirmId]/billing/page.tsx` | `@/components/ErrorNotification`, `@/components/ui/Button`, `@/components/ui/Tooltip`, `@/components/billingComp/InvoiceDetailPanel`, `@/components/billingComp/InvoicePDFDocument`, `@/components/ui/ListPager`, `@/components/ui/TabBar`, `@/components/ui/ListBusyIndicator`, `@/components/ui/ListSkeleton`, `@/components/ui/ListEmptyState`, `@/components/ui/StatusBadge`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/Card`, `@/components/ui/SectionLabel` | Invoices list, status tab filters, action names, and pager covered (`ClientBillingAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/calendar` | `frontend/src/app/client/lawfirm/[lawFirmId]/calendar/page.tsx` | `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/ListSkeleton`, `@/components/ui/ListEmptyState`, `@/components/ui/TruncatedListNotice`, `@/components/ui/StatusBadge`, `@/components/portalComp/ClientRecordPicker` | Agenda list structure, month/day labels, event cards, timezone preservation covered (`ClientCalendarAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/documents` | `frontend/src/app/client/lawfirm/[lawFirmId]/documents/page.tsx` | `@/components/filesComp/folderColors`, `@/components/LoadingSpinner`, `@/components/ui/ListSkeleton`, `@/components/ui/ListEmptyState`, `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/TruncatedListNotice`, `@/components/ui/ListToolbar`, `@/components/filesComp/FilePreviewModal`, `@/components/portalComp/RequestedDocumentsPanel`, `@/components/portalComp/UploadDocumentModal`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/Card`, `@/components/ui/Button` | Document requests expansion, keyboard upload modal selection and progress covered (`ClientDocumentsAccessibility.test.tsx`, `DocumentRequestAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/matters/[matterId]` | `frontend/src/app/client/lawfirm/[lawFirmId]/matters/[matterId]/page.tsx` | `@/components/ui/UploadProgressBar`, `@/components/filesComp/UploadStatus`, `@/components/LoadingSpinner`, `@/components/ErrorNotification`, `@/components/ui/ResourceNotFoundPage`, `@/components/ui/BackButton`, `@/components/ui/ListPager`, `@/components/ui/TruncatedListNotice`, `@/components/ui/InlineWarning`, `@/components/portalComp/RequestedDocumentsPanel`, `@/components/filesComp/FilePreviewModal`, `@/components/ui/MatterStatusBadge`, `@/components/ui/StatusBadge`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/Card`, `@/components/ui/SectionLabel` | Matter detail destinations, documents panel, and status badges covered (`ClientDetailDestinationsAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/matters` | `frontend/src/app/client/lawfirm/[lawFirmId]/matters/page.tsx` | `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/ListSkeleton`, `@/components/ui/ListEmptyState`, `@/components/ui/MatterStatusBadge`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/SectionLabel` | Named matter/search keyboard and result-feedback checks implemented (`ClientMattersAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/messages` | `frontend/src/app/client/lawfirm/[lawFirmId]/messages/page.tsx` | `@/components/messagesComp/ConversationView`, `@/components/ui/PageHeader`, `@/components/ui/Card`, `@/components/ui/SectionLabel` | Conversation messages, bubbles, composer, send/attachment controls covered (`ConversationAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]` | `frontend/src/app/client/lawfirm/[lawFirmId]/page.tsx` | `@/components/LoadingSpinner`, `@/components/ErrorNotification`, `@/components/ui/ResourceNotFoundPage`, `@/components/ui/ListPager`, `@/components/ui/ListEmptyState`, `@/components/ui/AuthButton`, `@/components/ui/MatterStatusBadge`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/SectionLabel` | Firm landing overview, matter navigation, action buttons covered (`ClientDetailDestinationsAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/settings` | `frontend/src/app/client/lawfirm/[lawFirmId]/settings/page.tsx` | `@/components/SuccessNotification`, `@/components/ui/Button`, `@/components/ui/Dropdown`, `@/components/ErrorNotification`, `@/components/LoadingSpinner`, `@/components/ui/Checkbox`, `@/components/ui/ThemeSelector`, `@/components/portalComp/ClientRecordPicker` | Preference controls, theme selector, notification checkboxes, saved announcements covered (`ClientSettingsAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/signatures` | `frontend/src/app/client/lawfirm/[lawFirmId]/signatures/page.tsx` | `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/ListSkeleton`, `@/components/ui/ListEmptyState` | Signature request listing, status badges, action links covered (`ClientSignaturesAccessibility.test.tsx`) |
| `/client/lawfirm/[lawFirmId]/trust` | `frontend/src/app/client/lawfirm/[lawFirmId]/trust/page.tsx` | `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/ListSkeleton`, `@/components/ui/ListEmptyState`, `@/components/portalComp/ClientRecordPicker`, `@/components/ui/Card`, `@/components/ui/SectionLabel` | Trust transaction table, balances, empty state, pagination covered (`ClientTrustAccessibility.test.tsx`) |
| `/client/messages/[lawFirmId]` | `frontend/src/app/client/messages/[lawFirmId]/page.tsx` | `@/components/messagesComp/ConversationView`, `@/components/ui/TabBar`, `@/components/LoadingSpinner` | Firm-scoped conversation view and navigation covered (`ConversationAccessibility.test.tsx`) |
| `/client/messages` | `frontend/src/app/client/messages/page.tsx` | `@/components/messagesComp/ConversationList`, `@/components/messagesComp/MessageSearch`, `@/components/ui/ListSkeleton`, `@/components/ErrorNotification`, `@/components/ui/ListPager`, `@/components/ui/Card` | Conversation list, search, unread badge counters, live filter covered (`MessagingAccessibility.test.tsx`) |
| `/complete-registration` | `frontend/src/app/complete-registration/page.tsx` | `@/components/ui/ParalegixLogo`, `@/components/ErrorNotification`, `@/components/LoadingSpinner`, `@/components/ui/AuthButton` | Initial checking/heading focus, refusal/dismissal focus, progress and keyboard retry covered (`CompleteRegistrationAccessibility.test.tsx`) |
| `/features` | `frontend/src/app/features/page.tsx` | `@/components/marketingComp/MarketingNav`, `@/components/marketingComp/MarketingFooter`, `@/components/marketingComp/MarketingTransition`, `@/components/marketingComp/Reveal`, `@/components/marketingComp/primitives`, `@/components/marketingComp/sections`, `@/components/marketingComp/Mockups`, `@/components/marketingComp/JsonLd` | Marketing navigation links, skip link, motion reduction, mockups covered (`MarketingAccessibility.test.tsx`, `MarketingMockAccessibility.test.tsx`) |
| `/intake/[token]` | `frontend/src/app/intake/[token]/page.tsx` | `@/components/LoadingSpinner`, `@/components/ui/Button`, `@/components/ui/Dropdown`, `@/components/ui/FieldError`, `@/components/ErrorNotification`, `@/components/ui/FieldLabel`, `@/components/ui/inputClasses` | Access-code gate, dynamic fields, required validation focus, and confirmation covered (`IntakeAccessibility.test.tsx`) |
| `/login` | `frontend/src/app/login/page.tsx` | `./LoginClient`, `@/components/marketingComp/JsonLd` | Keyboard recovery and authentication feedback regressions pass; full state/manual review pending |
| `/` | `frontend/src/app/page.tsx` | `@/components/marketingComp/SignedInRedirect`, `@/components/marketingComp/MarketingNav`, `@/components/marketingComp/MarketingFooter`, `@/components/marketingComp/MarketingTransition`, `@/components/marketingComp/Reveal`, `@/components/marketingComp/primitives`, `@/components/marketingComp/sections`, `@/components/marketingComp/Mockups`, `@/components/marketingComp/marketingData`, `@/components/marketingComp/JsonLd` | Public homepage navigation links, skip link, motion reduction, decorative mockups covered (`MarketingAccessibility.test.tsx`, `MarketingMockAccessibility.test.tsx`) |
| `/pricing` | `frontend/src/app/pricing/page.tsx` | `@/components/marketingComp/MarketingNav`, `@/components/marketingComp/MarketingFooter`, `@/components/marketingComp/MarketingTransition`, `@/components/marketingComp/Reveal`, `@/components/marketingComp/PricingPlans`, `@/components/marketingComp/PricingFaq`, `@/components/marketingComp/sections`, `@/components/marketingComp/marketingData`, `@/components/marketingComp/JsonLd` | Plan intervals, live-region price announcements, FAQ disclosure semantics covered (`MarketingAccessibility.test.tsx`) |
| `/privacy` | `frontend/src/app/privacy/page.tsx` | `@/components/ui/LegalPageHeader`, `@/components/ui/LegalPageFooter`, `@/components/marketingComp/JsonLd`, `@/components/ui/CookieSettingsLink` | Header/footer landmark semantics, cookie preferences link, heading hierarchy covered (`LegalAccessibility.test.tsx`) |
| `/register/invite` | `frontend/src/app/register/invite/page.tsx` | `@/components/ErrorNotification`, `@/components/LoadingSpinner`, `@/components/ui/AuthButton`, `@/components/ui/FieldLabel`, `@/components/ui/InvalidLinkPage`, `@/components/ui/ParalegixLogo`, `@/components/ui/PasswordInput`, `@/components/ui/SignupConsent`, `@/components/ui/Spinner` | Password keyboard/error regressions and DOM scans pass; full state/manual review pending |
| `/register` | `frontend/src/app/register/page.tsx` | `./RegisterClient`, `@/components/marketingComp/JsonLd` | Password keyboard/validation, provider field errors, backend refusal/dismissal focus and corrected verification flow covered; OAuth/signed-in/native validation/visual/manual review pending |
| `/reset-password` | `frontend/src/app/reset-password/page.tsx` | `@/components/ui/ParalegixLogo`, `@/components/ErrorNotification`, `@/components/LoadingSpinner`, `@/components/ui/InvalidLinkPage`, `@/components/ui/AuthButton`, `@/components/ui/FieldLabel` | Validation, provider rejection and success focus regressions pass; expired-link/timing/manual review pending |
| `/share/[token]` | `frontend/src/app/share/[token]/page.tsx` | `@/components/LoadingSpinner`, `@/components/ui/FieldError`, `@/components/filesComp/PublicSharePreviewModal`, `@/components/filesComp/PublicShareItems`, `@/components/ui/FieldLabel` | Password/token gate, file selection, download/preview covered (`SharePage.test.tsx`) |
| `/signature` | `frontend/src/app/signature/page.tsx` | `@/components/signaturesComp/PDFAnnotator`, `@/components/LoadingSpinner`, `@/components/ui/InvalidLinkPage`, `@/components/ui/UnexpectedErrorPage` | Field associations, text document reading layer, keyboard navigation, access code gate covered (`SigningFlowAccessibility.test.tsx`, `SigningDocumentTextAccessibility.test.tsx`, `AccessCodeAccessibility.test.tsx`, `PDFAnnotatorSubmit.test.tsx`) |
| `/subprocessors` | `frontend/src/app/subprocessors/page.tsx` | `@/components/ui/LegalPageHeader`, `@/components/ui/LegalPageFooter`, `@/components/marketingComp/JsonLd` | Header/footer landmarks, subprocessor table semantics, headings hierarchy covered (`LegalAccessibility.test.tsx`) |
| `/terms` | `frontend/src/app/terms/page.tsx` | `@/components/ui/LegalPageHeader`, `@/components/ui/LegalPageFooter`, `@/components/marketingComp/JsonLd` | Header/footer landmarks, headings hierarchy covered (`LegalAccessibility.test.tsx`) |
| `/verify-email` | `frontend/src/app/verify-email/page.tsx` | `@/components/ui/ParalegixLogo`, `@/components/ErrorNotification`, `@/components/LoadingSpinner`, `@/components/ui/AuthButton` | Resend status, cooldown isolation and failed-check focus regressions pass; full state/manual review pending |
| `/workflow` | `frontend/src/app/workflow/page.tsx` | `@/components/marketingComp/MarketingNav`, `@/components/marketingComp/MarketingFooter`, `@/components/marketingComp/MarketingTransition`, `@/components/marketingComp/Reveal`, `@/components/marketingComp/primitives`, `@/components/marketingComp/sections`, `@/components/marketingComp/Mockups`, `@/components/marketingComp/JsonLd` | Marketing navigation links, skip link, motion reduction, mockups covered (`MarketingAccessibility.test.tsx`, `MarketingMockAccessibility.test.tsx`) |

## Next implementation slices

1. **Client entry & Auth (Tasks 3 & 4):** login/reset-password, invitation acceptance/registration, verification, complete-registration, and account controls. Tested through real services and transport harness; failures have programmatic field associations and focus restoration.
2. **Dashboard and matters (Task 5):** Matter cards are keyboard-activatable links; matter search inputs have labeled announcements; aggregate firm totals are accessible without pointer dependence.
3. **Messages & Notifications (Task 5):** ConversationView, ConversationList, MessageInput, MessageBubble, attachment pickers, and notification bell. Composer labels, unread counters, and search are accessible to keyboard and screen readers.
4. **Documents & Uploads (Task 5):** RequestedDocumentsPanel and UploadDocumentModal. File drop zones have keyboard file selection; progress, errors, and preview focus return correctly.
5. **Billing and trust (Task 5):** Invoices list, tab bar, status filters, payment dialogs, and trust transaction tables. Headers and currency values are associated.
6. **Calendar and settings (Task 5):** Agenda list, date labels, event structure, and firm preference controls. Timezone handling and notification toggles preserved.
7. **Intake, share & signature (Task 6):** Dynamic intake fields, token access code gate, public file share items, and full signing flow (`RestrictedSigningView`, `SigningDocumentText`, `PDFAnnotator`, `AccessCodeGate`). Text reading fallback provided for PDF documents.
8. **Public/legal content (Task 3):** Marketing navigation links, skip link, collapsible FAQ disclosure, pricing interval announcements, decorative mockup hiding, and legal header/footer landmark structures.

## Static contrast results (2026-10-05)

`frontend/tests/styles/publicSurfaceContrast.test.ts` computes ratios from the token sources, since
jsdom cannot. These pairs fail WCAG AA and are recorded in that test as known failures, so a new
failure or a silent fix both turn it red:

| Theme | Pair | Ratio | Where |
|---|---|---|---|
| Dark | button text on accent fill | 4.08 | every primary `Button` |
| Dark | same, on hover | 3.49 | primary `Button` hover |
| Dark | button text on selected item | 4.08 | client dashboard |
| Dark | accent text on soft accent wash | 4.29 | chips and selected rows on client dashboard, matters, billing |
| Light | badge text on surface | emerald-600 3.48, amber-600 3.03, teal-600 3.47, cyan-600 3.42, pink-600 4.32 | `StatusBadge` success, warning, teal, cyan, pink |
| Light | red-600 on red-50 | 4.36 | error banner field lines and Retry; danger button hover |
| Light | emerald-500 on emerald-50 | 2.34 (needs 3) | success banner dismiss icon |
| Light | mkt-accent on mkt-ink | 4.02 | homepage workflow band label and step numbers |
| Light | mkt-ink-3 on mkt-paper | 4.49 | footer headings and fine print, hero label |
| Light | white on mkt-accent | 4.00 | marketing accent button, pricing "popular" badge |

Every route row above still needs the manual review below; the automatable state checks listed as
pending in rows for `/login`, `/register`, `/reset-password`, `/auth/action`, `/accept-invite`,
`/complete-registration` and `/account` were closed on 2026-10-05 (see the plan's progress log).

## Manual acceptance before accessibility claims

Use VoiceOver with Safari and NVDA with Chrome on the client journeys above. Check landmarks/headings, desktop/mobile controls, focus after navigation/dialogs, announced errors/status, readable document contents, and keyboard task completion. Scanned/image-only uploads and third-party payment interfaces require their own assessment. Browser automation is not authorized in this implementation request under AGENTS.md.
