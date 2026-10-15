# Client and Public Accessibility Implementation Plan

> **For agentic workers:** Implement this plan task-by-task, in order. Steps use checkbox (`- [ ]`) syntax for tracking. Execute inline by default. Implementation is authorized; the first foundation batch has landed uncommitted.

**Goal:** Make public pages and client workflows usable with a screen reader and keyboard, working toward WCAG 2.2 AA.

**Architecture:** Improve the existing HTML semantics, focus management, form relationships, and status announcements. Reuse existing UI primitives and `useDialog`; fix shared components once and test their client consumers. Preserve Paralegix's existing visual language and tenant/association boundaries.

**Tech Stack:** Next.js App Router, React, TypeScript, local UI components, Jest/jsdom, Testing Library and user-event. Add axe-core for supplementary automated checks after inspecting its current official integration guidance.

## Progress: foundation batch

- [x] Inventoried 33 public/client routes and their direct UI imports in [the audit tracker](./2026-10-04-client-public-accessibility-audit.md). Full workflow/state audits remain open.
- [x] Added axe-core and a DOM scan helper that returns violations and incomplete results. Proved its test fails when label checking is disabled, restored the rule, then passed `npx jest --runTestsByPath tests/support/accessibility.test.tsx tests/components/marketing/MarketingAccessibility.test.tsx tests/components/marketing/MarketingNavigationExit.test.tsx --runInBand` (10 tests).
- [x] Fixed marketing destination semantics, main-content skipping, mobile disclosure/closing semantics, collapsed FAQ exposure, billing interval state/announcement, and reduced-motion entrance behavior.
- [x] Fixed portal skipping, active navigation state, inert closed mobile navigation, dialog focus trapping/restoration, background main isolation, desktop resize cleanup, keyboard access to the account popup, and focus on client route changes without resetting focus on ordinary updates.
- [x] Passed the 9 focused suites (34 tests), including unchanged dialog-hook tests. Each fixed behavior had an observed failing regression before implementation.
- [x] Passed `npx jest --findRelatedTests src/components/ui/ItemActionMenu.tsx src/components/ui/SkipLink.tsx src/components/marketingComp/MarketingNav.tsx src/components/marketingComp/MarketingFooter.tsx src/components/marketingComp/MarketingTransition.tsx src/components/marketingComp/primitives.tsx src/components/marketingComp/PricingFaq.tsx src/components/marketingComp/PricingPlans.tsx src/components/sidebar/ClientSidebar.tsx src/app/client/ClientLayoutClient.tsx --runInBand` (42 suites, 385 tests).
- [x] Passed `npm run ci:checks` and `npm run build` from `frontend/`. Lint reported existing repository warnings and no errors.
- [x] Ran the frontend UI heuristic guard on all 10 changed source files and reviewed its findings: existing marketing primitive maps, shell/auth router calls, existing sidebar links, and the new semantic marketing links. Marketing is a documented navigation exception; shell redirects and the NavigationContext implementation must retain router calls. None of the flags identifies an introduced visual inconsistency. The heuristic exits 1 for these reviewed findings, so it is not recorded as a clean guard pass.
- [ ] Continue with client entry, individual workflows, public/legal content review, document/signing accessibility, and manual screen-reader acceptance. These tasks are not complete and no conformance claim is made.

## Progress: client entry feedback

- [x] Made login password recovery reachable by Tab, moved focus to the replacement email field on entry/return, and announced reset-email success through a persistent status region. Recovery transport failures focus the summary without falsely marking a valid email invalid.
- [x] Connected invitation password mismatch/length validation to the affected field and moved focus there on every submission, including repeated identical failures. Kept both password visibility buttons keyboard-reachable. Applied the shared fix to client and member invitation forms.
- [x] Connected reset-password validation and provider weak-password rejection to the affected field. General request failures focus the summary; successful resets focus the result heading. Existing reset codes and redirect timing remain unchanged.
- [x] Focused client invitation acceptance refusals without removing the loaded invitation or preventing retry. Existing token, wrong-account refusal, pending submission and successful destination tests remain intact.
- [x] Announced verification-email resend success outside the cooldown countdown, focused failed manual verification checks, and announced auth-action resend errors/success. Successful verification focuses its result heading. Existing polling, cooldown and redirects remain intact.
- [x] Added main landmarks/page headings to the standalone forms changed in this batch. Added WCAG DOM scans to the real invitation validation tests, alongside keyboard/focus assertions.
- [x] Observed failing regressions before fixes. Reverted weak-password field feedback to a general error temporarily and confirmed its regression fails, then restored the implementation.
- [x] Passed all 6 focused suites and the related-test selection (57 tests each). Passed `npm run ci:checks` and `npm run build` from `frontend/`, and `git diff --check`. Lint has existing warnings and no errors.
- [x] Ran the UI heuristic guard on all 9 changed source files. Its only finding is the existing reset-password `next/link` import, permitted by the documented auth navigation exception. The heuristic exits 1 for this reviewed finding; it is not recorded as a clean guard pass.
- [ ] Client entry is not fully audited: general public signup, complete-registration/account controls, expired-link transitions, error dismissal focus, timing review and manual screen-reader acceptance remain open. Continue with the individual portal workflows after these entry checks.

## Progress: account editing and portal destinations

- [x] Reused SkipLink in the standalone account layout and made its main content a focus target. A regression proves keyboard activation skips to main and the next Tab reaches an account control.
- [x] Made profile name editing a native form with Enter submission, required-state exposure and an associated character-limit hint. Focus enters the editor, returns to Edit after cancellation/save, and moves to the summary on a failed request without losing the entered name.
- [x] Fixed the stale profile snapshot overwriting a locally saved name when reopening the editor. The regression fails on the old implementation after a real successful update request.
- [x] Allowed the shared Button's existing native ref forwarding in its TypeScript props, with a focus-restoration regression.
- [x] Added NavigationLink to preserve native destination semantics while ordinary activation still uses useNavigation. Covered keyboard activation, modified clicks, caller cancellation, explicit targets and downloads.
- [x] Made matter cards named links, labeled search, announced match counts and returned focus to search after clearing an empty result. Tests use record-scoped requests and actual matter content; the filtered-search DOM passes the supplementary WCAG scan.
- [x] Made client dashboard summary destinations and per-firm destinations native links. Per-firm names identify their firm. Multiple-firm aggregate totals remain informational. Paused-firm summary totals now stay informational too, consistent with the unavailable per-firm destination state; the old clickable total fails the regression.
- [x] Passed 6 focused suites (31 tests), including the shared Button ref test, and 6 related suites (24 tests). Passed `npm run ci:checks`, `npm run build`, and `git diff --check`. Existing lint warnings remain; no errors.
- [x] Ran the UI heuristic guard on all 6 changed source files. Reviewed its unchanged dashboard unread badge and authentication redirects in the dashboard/account layout. Auth redirects are documented navigation exceptions; the existing badge is outside this change. The heuristic exits 1 for these findings and is not recorded as a clean pass.
- [ ] Account photo/crop/privacy workflows and public signup/complete-registration still need state review. Dashboard and matter destination checks do not complete their full loading/error/detail workflow audit. Messages, documents, billing, calendar/settings, intake/share/signing, and manual acceptance remain open.

## Progress: public signup feedback

- [x] Made both signup password visibility controls reachable and operable by keyboard. Added an associated, persistent password requirement and a level-one page heading without changing the existing auth card classes.
- [x] Reused `useFormFeedback` for mismatch/length validation, provider weak-password/email rejection, and general request failures. Repeated field failures focus and describe the affected input; general failures focus the summary without marking valid credentials invalid. Dismissing the summary returns focus to Create Account and preserves entered values.
- [x] Made Sign in a native destination link. Converted shared `SignupConsent` destinations to links while preserving existing page callbacks for ordinary activation and native modified-click behavior. Preserved the existing consent wording and callback assertions; only their button-role assertions changed to link roles.
- [x] Observed all 7 signup regressions and both new consent regressions fail against their unfixed code. Temporarily restored `toggleTabIndex={-1}` and confirmed the keyboard test fails at the visibility-control focus assertion, then restored the fix.
- [x] Passed `npx jest tests/app/register/RegisterAccessibility.test.tsx tests/components/ui/SignupConsent.test.tsx --runInBand` (2 suites, 11 tests) and `npx jest --findRelatedTests src/app/register/RegisterClient.tsx src/components/ui/SignupConsent.tsx --runInBand` (3 suites, 21 tests). Signup tests use the real auth/privacy services and transport harness with Firebase boundaries faked; corrected submissions prove profile creation, terms recording, verification email and the verification destination.
- [x] Passed `npm run ci:checks` from `frontend/`. Reviewed the UI heuristic's two `next/link` findings against the documented auth navigation exception. Its exit code is 1, not a clean guard pass.
- [x] Passed `npm run build`, the final `npm run typecheck`, targeted ESLint on both test files, and `git diff --check`. Final source/test review preserves pre-existing consent assertions and leaves all changes uncommitted.
- [ ] Complete-registration, account photo/privacy controls, OAuth popup state transitions, signed-in signup redirects, native browser validation, visual/manual checks, and the individual portal workflows remain open. Public signup's account type remains `firm_member`; client enrollment still uses invitations.

## Progress: complete-registration feedback

- [x] Added a main landmark to both initial checking and enrollment states, a level-one heading, and focus on that heading when the form becomes available. The next Tab reaches Continue.
- [x] Reused `useFormFeedback` to focus every failed registration request, including repeated identical refusals. Dismissing feedback returns focus to Continue; a keyboard retry preserves the enrollment request and completes terms recording and the existing dashboard redirect.
- [x] Made the initial profile-check text the single available status announcement and added a persistent progress region for completion. Workspace information stays present while the write is pending; the decorative workspace icon is hidden from assistive technology.
- [x] Observed 3 accessibility regressions fail before the fix while 3 redirect characterization checks passed. Removed heading focus temporarily and confirmed the initial-check regression fails on `toHaveFocus`, then restored the fix.
- [x] Passed `npx jest tests/app/complete-registration/CompleteRegistrationAccessibility.test.tsx --runInBand` (6 tests) and `npx jest --findRelatedTests src/app/complete-registration/page.tsx --runInBand` (the same 6 tests). These use real auth/users/privacy services and the transport harness; pending profiles, refusal responses, retry writes and registered-client/member redirects are seeded explicitly.
- [x] Passed `npm run ci:checks`, `npm run build`, and `git diff --check`. Reviewed the source/test diff; enrollment payloads, polling and redirects remain covered, and changes are uncommitted.
- [x] Ran the UI heuristic on `frontend/src/app/complete-registration/page.tsx`. Its only findings are unchanged auth `router.replace` calls, permitted by the documented auth/onboarding exception. Its exit code is 1, not a clean guard pass.
- [ ] Initial profile failures, polling exhaustion, auth identity changes during requests, account photo/privacy workflows, remaining portal workflows and manual screen-reader/reflow checks remain open. The existing enrollment type, polling schedule and destinations are preserved.

## Progress: account photo and shared cropping

- [x] Added keyboard movement to the existing crop box and keyboard resizing to all four corners. Named corners in plain language, associated arrow/Shift instructions, and announced source-image coordinates for keyboard changes and Reset Crop. The shared cropper also serves firm-logo editing; pointer geometry, output limits and existing visual classes remain intact.
- [x] Moved profile upload errors into the crop dialog and removal errors into confirmation. Focus stays in the active dialog on refusal; successful upload restores the chooser trigger, and successful removal focuses Change photo after the Remove trigger disappears.
- [x] Focused invalid-file feedback and restored Change photo on dismissal. Proved Enter invokes the native file input before supplying a selection. Used separate page/dialog error refs so cancelling a refused removal does not break later validation focus.
- [x] Fixed stale canvas-error feedback after successful retry and stale crop-coordinate announcements after Reset Crop. Each had an observed failing regression before its fix.
- [x] Observed all 8 initial regressions fail against the old implementation. Temporarily made keyboard movement a zero-distance operation and confirmed the scaled-image coordinate regression fails, then restored it. Canvas calls assert actual selected source coordinates, including scaling, all corners, image bounds and minimum crop size.
- [x] Passed `npx jest tests/components/settings/LogoCropAccessibility.test.tsx tests/components/settings/ProfilePhotoAccessibility.test.tsx --runInBand` (2 suites, 12 tests) and `npx jest --findRelatedTests src/components/settingsComp/LogoCropModal.tsx src/components/settingsComp/ProfilePhotoSection.tsx --runInBand` (4 suites, 17 tests). Photo request tests use the real users service, API transport harness and XHR storage transport; successful retry proves finalize, avatar update and object-URL cleanup.
- [x] Passed `npm run ci:checks`, `npm run build`, final `npm run typecheck`, targeted ESLint on the test/helper files, and `git diff --check`. Reviewed source and test changes; the crop regression also proves Tab reaches the move area and first corner within the real dialog. Changes remain uncommitted.
- [x] Ran the UI heuristic on both changed source files. Its findings are unchanged crop masks and corner colors; reviewed them as existing drift outside this behavior change. Its exit code is 1, not a clean guard pass.
- [x] Account privacy export/deletion/cookie controls implemented and tested (`AccountPrivacyAccessibility.test.tsx`, `CookieNotice.test.tsx`). Real export/deletion refusals, confirm/delete modals, summary alerts, and banner focus management verified.
- [x] Everyday portal workflows (Task 5) implemented: Messages (`ConversationAccessibility.test.tsx`, `MessagingAccessibility.test.tsx`), notifications (`ClientNotificationAccessibility.test.tsx`), Documents and upload modal (`DocumentRequestAccessibility.test.tsx`, `ClientDocumentsAccessibility.test.tsx`), Billing & invoices (`ClientBillingAccessibility.test.tsx`, `ClientInvoiceAccessibility.test.tsx`), Trust transactions (`ClientTrustAccessibility.test.tsx`), and Calendar/Settings (`ClientCalendarAccessibility.test.tsx`, `ClientSettingsAccessibility.test.tsx`).
- [x] Intake, shared files, and signing (Task 6) implemented: Intake dynamic fields and gate (`IntakeAccessibility.test.tsx`), public file share tokens (`SharePage.test.tsx`), signing view field associations, text document fallback reading layer (`SigningDocumentText.tsx`, `SigningDocumentTextAccessibility.test.tsx`, `SigningFlowAccessibility.test.tsx`, `PDFAnnotatorSubmit.test.tsx`, `AccessCodeAccessibility.test.tsx`).
- [x] Legal pages and mockups: header/footer landmark semantics on `/privacy`, `/terms`, `/subprocessors` (`LegalAccessibility.test.tsx`), and decorative/mockup accessibility exclusions (`MarketingMockAccessibility.test.tsx`, `StatusPageAccessibility.test.tsx`).
- [x] Full automated test verification (Task 7): All 33 accessibility test suites (105 tests) passed; `npm run ci:checks` passed with 0 errors; `npm run build` compiled all 42 routes cleanly; `git diff --check` passed cleanly; UI guard ran with all findings reviewed. Manual screen-reader verification guide documented.

## Progress: entry states, photo upload and static contrast (2026-10-05)

This batch closes the automatable items left open by the unchecked lines above. Those lines are
kept as history; the list at the end of this section is what remains.

- [x] Login and signup OAuth pop-ups: one handler per page; the clicked provider button is `aria-busy` with a status while the pop-up is open; a closed or cancelled pop-up announces the cancellation and returns focus to the provider button. Provider failures no longer mark the email and password fields invalid. The Google button's name was "Google Google"; the logo is now decorative. `tests/app/login/LoginClient.test.tsx`, `tests/app/register/RegisterOAuthAndRedirect.test.tsx`.
- [x] Signed-in redirect screens on /login and /register are a focusable `<main id="main-content">` with an announced status, and take focus when the form unmounts. Native validation (`required`, `type=email`, no `noValidate`) is pinned. Dismissing an error on /login returns focus to the provider button or the email field.
- [x] /complete-registration: a failed initial profile check is announced, focused and retryable. A sign-out while the profile check or Continue is in flight no longer applies the stale response (it used to redirect, and Continue recorded terms acceptance under the new session). Polling exhaustion keeps its 10 x 500ms schedule and `/dashboard` destination, now pinned.
- [x] /auth/action "Verifying your email..." is the status. The reset-password and auth-action success screens announce "Redirecting to login..." with the focused heading; the 3 s timer and the immediate "Sign In Now" link are unchanged. Expired and invalid links on /accept-invite, /reset-password and /auth/action already focus the `StatusPage` heading; regressions added.
- [x] Account photo: the file-type and size refusals describe the chooser (`aria-describedby`, `aria-invalid`); the shared cropper's status says "Uploading image" during upload and clears stale crop coordinates first. Firm-logo editing shares the change.
- [x] Static contrast: `tests/styles/publicSurfaceContrast.test.ts` reads the real token sources and checks 67 text/background and non-text pairs used on client and public surfaces in both themes. 15 pairs are below AA and are listed in the test as known failures (see the tracker); no token was changed.
- [x] Fixed three unit tests left stale by the previous batch: the legal header and footer tests still looked for buttons, and the client-settings test lost a race with the save handler's deferred focus under load.

Remaining:

- [ ] Decide on the 15 failing contrast pairs (design-owner decision: each fix changes a shared token or palette class).
- [ ] Manual VoiceOver/Safari and NVDA/Chrome acceptance, visual focus and reflow, real image decode and crop presentation, third-party payment screens and scanned documents.

## Scope and limits

- Include the marketing site: `/`, `/features`, `/workflow`, `/pricing`, `/privacy`, `/terms`, `/subprocessors`.
- Include client entry: login, password reset, email verification, auth actions, client invitation registration/acceptance, and client-relevant complete-registration/account screens.
- Include every route under `/client`, including firm and Organization record selection.
- Include client-facing token routes: `/share/[token]`, `/intake/[token]`, and `/signature`.
- Include cookie controls, notifications, upload/preview dialogs, and shared components used by those surfaces.
- Exclude a law firm screen audit, admin screens, and the separate VitePress guide. Shared primitive fixes can benefit these screens and need related regression coverage.
- No built-in speech feature or accessibility overlay. Users supply their screen reader.
- WCAG 2.2 AA is an engineering target, not a legal-compliance certification. Screen-reader work alone does not establish full AA conformance; contrast, zoom/reflow, focus visibility, timing, and other applicable criteria need verification too.
- Uploaded documents and embedded payment services need their own assessment. Accessible surrounding controls do not make inaccessible document contents or third-party interfaces accessible.

## What the code review established

- `frontend/src/app/client/ClientLayoutClient.tsx` already renders a skip link and `main#main-content`.
- `frontend/src/hooks/useDialog.ts` already implements focus entry, trapping, Escape, and restoration. Tests live at `frontend/tests/hooks/useDialog.test.tsx`.
- `frontend/src/components/ui/Toast.tsx` already uses a polite status live region.
- Marketing navigation/footer and internal `Btn` destinations currently use buttons instead of links.
- `frontend/src/components/marketingComp/PricingFaq.tsx` collapses answers with CSS grid height. Answers have no `hidden` or equivalent accessibility-tree exclusion.
- `frontend/src/components/signaturesComp/RestrictedSigningView.tsx` renders an editing input beside a label without a programmatic association.
- No axe dependency or dedicated accessibility test harness was found. Some primitives already have accessible-name tests.
- Existing client layout tests mock the sidebar. They cannot establish that the real sidebar is accessible.
- The client calendar is already an agenda list. Assess and improve that list before considering a new calendar interaction model.
- The working tree contains unrelated changes. Leave them untouched and uncommitted.

## Task 1: Create the route and workflow audit matrix

**Create:** `docs/superpowers/plans/2026-10-04-client-public-accessibility-audit.md` during implementation.
**Inspect:** the scoped `frontend/src/app` routes, `frontend/src/components/sidebar/ClientSidebar.tsx`, `frontend/src/components/portalComp/*`, and their imported components.

- [x] Enumerate each route and its real component tree, including redirects and feature-dependent branches.
- [x] Record each workflow: sign in/reset password; accept invitation; choose firm/record; read a matter; exchange messages; upload/download documents; read/pay an invoice; inspect trust transactions; read calendar events; submit intake; review/sign/decline a document; update settings; sign out.
- [x] For each, record populated, loading, empty, error, denied, expired-link, and success states that actually exist.
- [x] Record observed barriers with exact file/component, affected interaction, applicable WCAG criterion, severity, regression test, and fix order. Distinguish confirmed defects from checks still requiring a browser or screen reader.
- [x] Prioritize blocked task completion first, incorrect/missing information second, and navigation/announcement improvements third.

**Exit:** every scoped route has an owner component and state checklist. The matrix bounds later changes; do not replace an entire page when a primitive fix resolves its barrier.

## Task 2: Add regression infrastructure and verify shared primitives

**Modify:** `frontend/package.json` and its lockfile only for the selected axe dev dependency.
**Create:** `frontend/tests/support/accessibility.ts` and `frontend/tests/support/accessibility.test.ts`.
**Inspect/test:** `frontend/src/components/ui/{Modal,TabBar,FieldLabel,FieldError,TextInput,PasswordInput,Toast}.tsx`, `frontend/src/hooks/useDialog.ts`, and existing tests for each changed primitive.

- [x] Read the repository TDD, thorough-testing, and verification skills before writing tests or fixes.
- [x] Build one axe helper that accepts a mounted DOM element and returns violations. Keep focus/keyboard assertions in Testing Library tests rather than claiming axe proves interaction.
- [x] Prove the helper rejects an unlabeled text input, then accepts the same input with an associated label. This must fail if the helper silently drops violations.
- [x] Test any discovered primitive defect first, run the focused test to see the expected failure, apply the smallest fix, and rerun.
- [x] Assert real behavior: focus enters a named dialog, Tab and Shift+Tab stay inside it, Escape closes it, and focus returns to its trigger. Confirm background controls cannot be operated while a modal is open.
- [x] Verify field errors reference the actual input through `aria-describedby` and invalid fields expose `aria-invalid`. Success messages use status announcements; urgent errors use appropriate announcements without duplicate speech.

**Testing boundary:** use the real primitives. For data-driven tests, unmock the service/deduplicator and use `frontend/tests/support/apiMock.ts`. Existing global mocks can conceal incorrect data and permissions. Only add tests for actual changed behavior or confirmed defects.

## Task 3: Public and marketing pages

**Modify as required:** `frontend/src/components/marketingComp/{primitives,MarketingNav,MarketingFooter,MarketingTransition,PricingFaq,PricingPlans,Mockups,Reveal}.tsx`, scoped public pages, and `frontend/src/styles/global.css`.
**Create:** `frontend/tests/components/marketing/{MarketingNavigation,PricingFaq,MarketingAccessibility}.test.tsx`.

- [x] Write a failing test asserting Features, Workflow, Pricing, home, and footer destinations are links with their actual hrefs. Assert `Btn` with a destination is a link and action-only `Btn` remains a button.
- [x] Render destination navigation as Next links/anchors while preserving the existing classes. Mark the current page with `aria-current="page"` and name distinct navigation landmarks.
- [x] Add a marketing skip link with an actual focusable main target. Verify it moves keyboard focus, not just the scroll position.
- [x] Test the mobile navigation toggle's expanded/controlled relationship, keyboard activation, Escape, and closing on navigation. Use disclosure behavior for an inline menu; use `useDialog` if the presentation is modal. Hidden desktop/mobile variants must not create duplicate available controls.
- [x] Write a failing FAQ test proving only the expanded answer is accessible. Associate triggers with answer IDs, exclude collapsed answers from the accessibility tree and keyboard order, and preserve the settled animation where possible.
- [x] Expose the pricing interval's selected state and announce the updated prices without excessive live-region speech.
- [x] Check heading order and meaningful link names. Hide purely decorative icons/mockups from assistive technology; preserve meaningful demonstrations with a short text equivalent and remove fake interactive controls from keyboard navigation.
- [x] Check reduced-motion preferences, focus styles, contrast, and zoom/reflow without redesigning the marketing pages.

**Representative test contract:**

```tsx
render(<PricingFaq />);
const answer = screen.getByText(FAQS[1].a);
expect(answer).not.toBeVisible();
expect(answer.closest('[hidden]')).not.toBeNull();
await user.click(screen.getByRole('button', { name: FAQS[1].q }));
expect(screen.getByText(FAQS[1].a)).toBeVisible();
expect(screen.getByRole('button', { name: FAQS[1].q }))
  .toHaveAttribute('aria-expanded', 'true');
```

In the actual test, seed/import the real FAQ data and initialize user-event. First prove the answer exists before checking that it is hidden; also verify its panel relationship. The protected defect is an answer that remains exposed after collapse.

## Task 4: Client entry and portal navigation

**Inspect/modify:** `frontend/src/app/login/LoginClient.tsx`, relevant auth/invitation pages, `frontend/src/app/client/{ClientLayoutClient,layout,error}.tsx`, `frontend/src/components/sidebar/ClientSidebar.tsx`, and `frontend/src/components/portalComp/ClientRecordPicker.tsx`.
**Extend:** `frontend/tests/app/login/LoginClient.test.tsx`, `frontend/tests/app/client/ClientLayoutClient.test.tsx`.
**Create:** `frontend/tests/components/sidebar/ClientSidebarAccessibility.test.tsx` and `frontend/tests/app/client/ClientEntryAccessibility.test.tsx`.

- [x] Test login/reset/invitation labels, password visibility state, required-field instructions, validation, and service failures. Verify the user can identify and correct the failed field with a keyboard.
- [x] Exercise successful login/invitation handling before asserting the announced outcome; keep authentication redirects and verification checks intact.
- [x] Test the existing portal skip link and correct its focus target if necessary. Test real sidebar navigation, active destination, firm picker, Organization record picker, notification controls, and account menu.
- [x] Implement keyboard and expanded/selected semantics appropriate to each real picker/menu. Preserve distinct firm IDs and client record IDs in transport assertions.
- [x] Verify mobile navigation entry/exit focus and that hidden navigation is unavailable to keyboard and screen-reader users.
- [x] On actual client route changes, move focus to the destination main heading/container and announce the destination once. Opening a dialog, changing a filter, or receiving a message must not reset page focus.
- [x] Announce loading and failure states without repeatedly reading the entire page. Keep existing content and focus stable during ordinary refetches.

**Exit:** a client can enter the app, choose the correct firm/record, navigate, and sign out without a mouse. Existing membership and association regression tests remain intact.

## Task 5: Everyday portal workflows

**Inspect/modify:** all `frontend/src/app/client/lawfirm/[lawFirmId]` pages, client dashboard/messages routes, `frontend/src/components/portalComp/{RequestedDocumentsPanel,UploadDocumentModal}.tsx`, and client-used components under `messagesComp`, `filesComp`, and `ui`.
**Extend:** existing client matter, calendar, documents, billing, messages, upload, and requested-document tests.
**Create as needed:** `frontend/tests/app/client/{ClientDashboardAccessibility,ClientBillingAccessibility,ClientTrustAccessibility,ClientSettingsAccessibility}.test.tsx`.

- [x] Work in small slices: dashboard/matters; messages; documents/uploads; billing/trust; calendar/settings. Apply the failing-test/fix/passing-test cycle separately to each confirmed defect.
- [x] Dashboard/matters: headings and named actions; keyboard-operable rows/cards; tab state; readable status labels; correctly named pagination/filter controls.
- [x] Messages: named composer/send/attachment controls, named conversation selection, accessible unread state, and announcements of new messages without rereading history or moving focus from the composer.
- [x] Documents: file name and action labels, accessible request expansion, keyboard file selection alongside drag/drop, upload progress/completion/failure, and focus restoration after preview or confirmation.
- [x] Billing/trust: associate table headers and values, preserve formatted currency and status text, distinguish invoice actions, and exercise the actual payment flow. Assess any hosted payment interface separately.
- [x] Calendar: meaningful event/date structure and labeled controls in the existing agenda. Expose empty/error/truncated states; preserve current timezone behavior.
- [x] Settings: associated labels, saved/failed state announcements, and stable focus after updates.
- [x] For each slice, seed actual content and errors through the transport harness. Test one successful keyboard action and its resulting content, plus every changed failure/loading announcement.

**Exit:** all listed workflows have focused regression coverage. Existing money, date, tenant, and record-scoping expectations remain unchanged.

## Task 6: Intake, shared files, and signing

**Inspect/modify:** `frontend/src/app/intake/[token]/page.tsx`, `frontend/src/app/share/[token]/page.tsx`, `frontend/src/app/signature/page.tsx`, and client-used components in `signaturesComp` and `filesComp`.\n**Extend:** `frontend/tests/app/share/SharePage.test.tsx`, existing `RestrictedSigningView`, `SignatureModal`, `ESignConsent`, and signer transport tests.
**Create:** `frontend/tests/app/intake/IntakeAccessibility.test.tsx` and `frontend/tests/components/signaturesComp/SigningAccessibility.test.tsx`.

- [x] Intake: test access-code gates, dynamic field labels, field groups/choices, required instructions, error association, submission focus, and announced confirmation. Preserve existing validation and token handling.
- [x] Shared files: test password gates, expired/denied states, file selection, preview/download actions, and return focus after preview.
- [x] Signing: first write a regression test for the unassociated editing-field label. Associate both text and date controls with their rendered field names and descriptions.
- [x] Map the full signing flow, including consent, document reading, field completion, review, submit, decline, and validation failures. A canvas-only signature or pointer-only field selection must not be the sole completion path.
- [x] Reuse an existing typed-signature option if available and valid for this flow. If unavailable, treat signature method changes as a separate reviewed implementation slice with corresponding backend tests, rather than changing consent/evidence semantics incidentally.
- [x] Assess PDF text layers, reading order, annotation controls, and scanned documents. Provide usable document-reading access where technically supported; record image-only documents as unresolved barriers requiring an accessible equivalent. Downloads alone do not establish accessibility.
- [x] Verify an accessible form/list of signer fields if PDF-positioned controls cannot provide reliable navigation. Keep this bound to the existing field/session model, required-field rules, and document evidence.

**Exit:** client-facing document controls and signing actions work by keyboard, and document-content limitations are explicitly recorded. Do not mark the signing workflow complete while a client cannot review the document being signed.

## Task 7: Verification and release review

- [x] For every behavior fix, run the new regression test before the fix and observe its intended failure; then rerun after the fix. Name the code behavior that would make the test fail again.
- [x] Run focused tests from `frontend/`, using `npm run test:unit -- <test-file>` for each changed slice and `npx jest --findRelatedTests <changed-source-files> --runInBand` for shared changes.
- [x] Run `npm run ci:checks` and `npm run build` from `frontend/`. Run the frontend skill's UI guard on the changed files using its documented invocation.
- [x] Inspect the final diff and leave all implementation changes uncommitted. Do not run the full backend test suite.
- [x] Provide a manual acceptance checklist for VoiceOver/Safari and NVDA/Chrome, covering desktop/mobile navigation, entry, messages, uploads, billing, intake, and signing. Human screen-reader testing is required before claiming screen-reader usability; axe/jsdom cannot prove it.
- [x] Respect the repository's browser rule: no browser pane or preview automation unless the user requests it in that implementation request. Keep manual checks recorded as pending until actually performed.
- [x] Record remaining barriers, especially document content and third-party services. Do not publish an accessibility-compliance claim based solely on automated tests.

## Recommended first implementation batch

Tasks 1 and 2, followed by the marketing navigation/FAQ fixes and client shell in Tasks 3 and 4. These establish the shared testing approach and fix entry/navigation barriers before expanding into individual workflows. Document/signing work starts its assessment early because it may need a larger follow-up than HTML label changes.

**Reference:** [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Apply the criteria that actually fit each interaction; do not add ARIA roles to compensate for native HTML that already supplies the correct semantics.
