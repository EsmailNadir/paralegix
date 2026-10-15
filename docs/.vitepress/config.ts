import { defineConfig } from 'vitepress'
import fs from 'node:fs'
import path from 'node:path'

// Internal / engineering / admin documentation (the "Dev" section) is only built
// when DOCS_INCLUDE_DEV=true. The default PUBLIC build EXCLUDES it entirely via
// srcExclude — the pages are not emitted, not merely unlinked — so the public
// docs site never serves internal architecture, admin, or ops content. To make
// the Dev section available to admins, run a separate build with
// DOCS_INCLUDE_DEV=true and deploy it behind access control (e.g. Vercel
// Password Protection or SSO). See docs/dev/index.md.
const INCLUDE_DEV = process.env.DOCS_INCLUDE_DEV === 'true'

// Search configuration: The site uses VitePress's built-in compile-time local search.
// It builds its index directly from markdown source without requiring an external crawler,
// so search remains fast and fully functional behind the authentication gate.
const search: import('vitepress').DefaultTheme.Config['search'] = {
  provider: 'local',
  // Drop the excerpt/"detailed view" panel so the search result is a clean
  // list of page + heading matches rather than a busy preview.
  options: { disableDetailedView: true },
}

// Content excluded from EVERY build (public and admin alike):
// - superpowers/**: raw working design specs, unpolished and containing markup
//   VitePress cannot render (unclosed angle-bracket placeholders).
// - AGENTS.md / CLAUDE.md: repo-internal agent guidance and its import pointer,
//   not user or developer documentation. They must never render as pages or
//   leak into the text export.
const ALWAYS_EXCLUDE = ['superpowers/**', 'AGENTS.md', 'CLAUDE.md']

// Everything that makes up the internal / Dev section. Kept out of the public
// build unless INCLUDE_DEV is set. Note: the polished user pages under
// authentication/, templates/, and document-signing/ are NOT here — they stay
// public. The engineering `features/*` docs are separate internal reference.
const DEV_GLOBS = [
  'dev/**',
  'features/**',
  'future/**',
  'STAGING_SETUP.md',
  'TRUST_STRIPE_COMPLIANCE.md',
  'DIRECT_CHARGE_MIGRATION.md',
  'PRODUCTION_CUTOVER.md',
]

// Public, user-facing guide.
const userGuideSidebar = [
  {
    text: 'Getting Started',
    items: [
      { text: 'Introduction', link: '/' },
      { text: 'Export for AI', link: '/export' },
    ],
  },
  {
    text: 'Authentication',
    items: [{ text: 'Login', link: '/authentication/login' }],
  },
  {
    text: 'Dashboard',
    items: [{ text: 'Overview', link: '/dashboard/overview' }],
  },
  {
    text: 'Matters',
    items: [{ text: 'Overview', link: '/matters/overview' }],
  },
  {
    text: 'Tasks',
    items: [{ text: 'Overview', link: '/tasks/overview' }],
  },
  {
    text: 'Clients',
    items: [
      { text: 'Overview', link: '/clients/overview' },
      { text: 'The Client Portal', link: '/clients/portal' },
    ],
  },
  {
    text: 'Leads',
    items: [{ text: 'Overview', link: '/leads/overview' }],
  },
  {
    text: 'Contacts',
    items: [{ text: 'Overview', link: '/contacts/overview' }],
  },
  {
    text: 'Calendar',
    items: [{ text: 'Overview', link: '/calendar/overview' }],
  },
  {
    text: 'Files',
    items: [{ text: 'Overview', link: '/files/overview' }],
  },
  {
    text: 'Messages',
    items: [{ text: 'Overview', link: '/messaging/overview' }],
  },
  {
    text: 'Billing',
    items: [
      { text: 'Overview', link: '/billing/overview' },
      { text: 'Time and Expenses', link: '/billing/time-and-expenses' },
      { text: 'Generating Invoices', link: '/billing/generating-invoices' },
      { text: 'Invoices', link: '/billing/invoices' },
      { text: 'Payments and Plans', link: '/billing/payments' },
      { text: 'Reports', link: '/billing/reports' },
    ],
  },
  {
    text: 'Trust Accounting',
    items: [{ text: 'Overview', link: '/trust/overview' }],
  },
  {
    text: 'Templates',
    items: [
      { text: 'Overview', link: '/templates/overview' },
      { text: 'Filling a Template', link: '/templates/fill' },
    ],
  },
  {
    text: 'Automation',
    items: [
      { text: 'Overview', link: '/automation/overview' },
      { text: 'Reminders and Alerts', link: '/automation/reminders-and-alerts' },
      { text: 'Recurring Work', link: '/automation/recurring-work' },
      { text: 'Billing Automation', link: '/automation/billing-automation' },
      { text: 'Documents and Calendar', link: '/automation/documents-and-calendar' },
    ],
  },
  {
    text: 'Document Signing',
    items: [
      { text: 'Overview', link: '/document-signing/overview' },
      { text: 'Sending for Signing', link: '/document-signing/send-for-signing' },
      { text: 'Signer Experience', link: '/document-signing/signer-experience' },
      { text: 'Signing Templates', link: '/document-signing/signing-templates' },
    ],
  },
  {
    text: 'Firm Settings',
    items: [
      { text: 'Overview', link: '/settings/overview' },
      { text: 'Team Members', link: '/settings/members' },
      { text: 'Roles and Permissions', link: '/settings/roles' },
      { text: 'Deadline Sets', link: '/settings/deadline-sets' },
    ],
  },
]

// Internal / admin / engineering sidebar (only reachable in the flagged build).
const devSidebar = [
  {
    text: 'Developer Docs',
    items: [{ text: 'Overview', link: '/dev/' }],
  },
  {
    text: 'Getting Started',
    items: [
      { text: 'Architecture Overview', link: '/dev/getting-started/architecture' },
      { text: 'Local Development', link: '/dev/getting-started/local-development' },
      { text: 'Testing', link: '/dev/getting-started/testing' },
    ],
  },
  {
    text: 'Concepts',
    items: [
      { text: 'Money Handling', link: '/dev/concepts/money' },
      { text: 'Event Bus & Outbox', link: '/dev/concepts/event-bus-outbox' },
    ],
  },
  {
    text: 'Admin',
    items: [
      { text: 'Rate Limiting', link: '/dev/admin/rate-limiting' },
    ],
  },
  {
    text: 'Security & Compliance',
    items: [
      { text: 'Auth & Tokens', link: '/dev/security/auth-tokens' },
      { text: 'RBAC & Permissions', link: '/dev/security/rbac-permissions' },
      { text: 'Multi-Tenancy & Isolation', link: '/dev/security/multi-tenancy' },
      { text: 'Audit Logging', link: '/dev/security/audit-logging' },
      { text: 'Privacy & Data Rights', link: '/dev/security/privacy-data-rights' },
      { text: 'PostHog Analytics & Cookie Consent', link: '/dev/security/posthog-analytics' },
      { text: 'Unverified-Account Sweep', link: '/dev/security/unverified-account-sweep' },
      { text: 'Secrets', link: '/dev/security/secrets' },
    ],
  },
  {
    text: 'Operations',
    items: [
      { text: 'Cron Jobs', link: '/dev/ops/cron-jobs' },
      { text: 'Webhooks', link: '/dev/ops/webhooks' },
      { text: 'Environment Variables & Flags', link: '/dev/ops/environment-variables' },
      { text: 'Database', link: '/dev/ops/database' },
      { text: 'Deployment', link: '/dev/ops/deployment' },
      { text: 'Cloud Architecture', link: '/dev/ops/cloud-architecture' },
      { text: 'Incident Runbook', link: '/dev/ops/incident-runbook' },
    ],
  },
  {
    text: 'Engineering Reference',
    items: [
      { text: 'Feature Index', link: '/features/README' },
      { text: 'Dashboard', link: '/features/dashboard' },
      { text: 'Matters', link: '/features/matters' },
      { text: 'Tasks', link: '/features/tasks' },
      { text: 'Clients', link: '/features/clients' },
      { text: 'Identity Verification', link: '/features/identity-verification' },
      { text: 'Leads', link: '/features/leads' },
      { text: 'Contacts', link: '/features/contacts' },
      { text: 'Calendar', link: '/features/calendar' },
      { text: 'Billing', link: '/features/billing' },
      { text: 'Trust Accounting', link: '/features/trust-accounting' },
      { text: 'Stripe Payments & Connect', link: '/features/stripe-payments' },
      { text: 'Templates', link: '/features/templates' },
      { text: 'Messaging', link: '/features/messaging' },
      { text: 'E-Signatures', link: '/features/e-signatures' },
      { text: 'Files', link: '/features/files' },
      { text: 'Document Requests & Share Links', link: '/features/document-requests' },
      { text: 'Document Conversion', link: '/features/document-conversion' },
      { text: 'Settings', link: '/features/settings' },
      { text: 'Reference Data', link: '/features/reference-data' },
      { text: 'Authentication', link: '/features/authentication' },
      { text: 'Law Firms / RBAC / Plans', link: '/features/lawfirms-rbac-plans' },
      { text: 'Admin Console', link: '/features/admin-console' },
      { text: 'Invitations', link: '/features/invitations' },
      { text: 'Notifications', link: '/features/notifications' },
      { text: 'Server-Side Search', link: '/features/server-side-search' },
    ],
  },
  {
    text: 'Runbooks & Migrations',
    items: [
      { text: 'Staging Setup', link: '/STAGING_SETUP' },
      { text: 'Trust / Stripe Compliance', link: '/TRUST_STRIPE_COMPLIANCE' },
      { text: 'Direct Charge Migration', link: '/DIRECT_CHARGE_MIGRATION' },
      { text: 'Production Cutover', link: '/PRODUCTION_CUTOVER' },
    ],
  },
]

// Internal "Future" sidebar: roadmap and known-gap notes. Same admin-only
// gating as the Dev section (only reachable when DOCS_INCLUDE_DEV is set).
const futureSidebar = [
  {
    text: 'Future',
    items: [
      { text: 'Overview', link: '/future/' },
      { text: 'Roadmap', link: '/future/roadmap' },
      { text: 'Tech Debt & Known Gaps', link: '/future/tech-debt' },
      { text: 'Preset Document Templates (Research)', link: '/future/court-form-templates-research' },
      { text: 'Signatures Without LibreOffice (Research)', link: '/future/signatures-without-libreoffice' },
      { text: 'Backend Performance Investigation', link: '/future/backend-performance-investigation' },
      { text: 'UI for Older Users (Research)', link: '/future/ui-for-older-users-research' },
    ],
  },
]

// Artifacts written into the built site (served under `<base>/`) that power the
// "Export for AI" feature:
//   - paralegix-docs.txt  : the whole guide concatenated as one plain-text file.
//   - paralegix-docs.json : the same content grouped by section, so the on-page
//                           picker can let users choose which sections to include.
// Both respect the public/dev split: the public build contains only the user
// guide; the admin build (DOCS_INCLUDE_DEV=true) additionally includes the dev
// pages. See the DocsExport component for the client-side picker.
const LLM_EXPORT_TXT = 'paralegix-docs.txt'
const LLM_EXPORT_JSON = 'paralegix-docs.json'

// Pages that are excluded from the export itself: the home page (mostly hero
// frontmatter) and the Export page (describes the feature, not the product).
const EXPORT_SKIP = new Set(['index.md', 'export.md'])

type SidebarItem = { text: string; link?: string }
type SidebarGroup = { text: string; items: SidebarItem[] }
type ExportPage = { source: string; title: string; text: string }
type ExportSection = { id: string; title: string; pages: ExportPage[] }

// Convert a site link ('/', '/billing/overview', '/features/README') to the
// source markdown path relative to srcDir ('index.md', 'billing/overview.md',
// 'features/README.md').
function linkToPagePath(link: string): string {
  const trimmed = link.replace(/^\//, '').replace(/\/$/, '')
  return (trimmed === '' ? 'index' : trimmed) + '.md'
}

// Strip a leading YAML frontmatter block (--- ... ---) from raw markdown so the
// exported text starts at the real content, not the page metadata.
function stripFrontmatter(md: string): string {
  if (!md.startsWith('---')) return md
  const close = md.indexOf('\n---', 3)
  if (close === -1) return md
  const afterFence = md.indexOf('\n', close + 1)
  return afterFence === -1 ? '' : md.slice(afterFence + 1)
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

// Read every page referenced by the sidebar(s) for THIS build and group them by
// their sidebar section. Reading straight from the sidebar (rather than a raw
// glob) gives stable grouping and reading order, and reuses the same public/dev
// split the sidebars already encode. Empty and skipped pages are dropped, and a
// section with no remaining pages is omitted entirely.
function collectSections(srcDir: string): ExportSection[] {
  const groups: SidebarGroup[] = INCLUDE_DEV
    ? [...userGuideSidebar, ...devSidebar, ...futureSidebar]
    : [...userGuideSidebar]

  const sections: ExportSection[] = []
  for (const group of groups) {
    const pages: ExportPage[] = []
    for (const item of group.items) {
      if (!item.link) continue
      const rel = linkToPagePath(item.link)
      if (EXPORT_SKIP.has(rel)) continue
      let raw: string
      try {
        raw = fs.readFileSync(path.join(srcDir, rel), 'utf-8')
      } catch {
        continue
      }
      const text = stripFrontmatter(raw).trim()
      if (!text) continue
      pages.push({ source: rel, title: item.text, text })
    }
    if (pages.length) {
      sections.push({ id: slugify(group.text), title: group.text, pages })
    }
  }
  return sections
}

// Concatenate the given sections into one plain-text bundle. Mirrors the format
// the client-side picker uses so a full download and a picked-subset download
// look identical apart from which sections are present.
function buildExportText(sections: ExportSection[]): string {
  const rule = '='.repeat(70)
  const parts = [
    'PARALEGIX DOCUMENTATION',
    INCLUDE_DEV
      ? 'Full export including internal / developer documentation.'
      : 'User guide export. Paste this into an AI assistant and ask it about using Paralegix.',
    `Sections: ${sections.length}`,
  ]
  for (const section of sections) {
    for (const page of section.pages) {
      parts.push(`\n\n${rule}\nSource: ${page.source}\n${rule}\n\n${page.text}`)
    }
  }
  return parts.join('\n')
}

function buildExportJson(sections: ExportSection[]): string {
  return JSON.stringify({
    scope: INCLUDE_DEV ? 'admin' : 'public',
    sections,
  })
}

// Write both export artifacts into the output directory at the end of a build.
function writeExportArtifacts(siteConfig: { srcDir: string; outDir: string }): void {
  const sections = collectSections(siteConfig.srcDir)
  fs.writeFileSync(path.join(siteConfig.outDir, LLM_EXPORT_TXT), buildExportText(sections), 'utf-8')
  fs.writeFileSync(path.join(siteConfig.outDir, LLM_EXPORT_JSON), buildExportJson(sections), 'utf-8')
}

// In the dev server the build artifacts do not exist yet, so serve them on the
// fly from source. `npm run dev` is launched from the docs root, so cwd is the
// srcDir. This keeps the on-page picker working in development without writing
// generated files into the repo.
const exportDevServerPlugin = {
  name: 'paralegix-docs-export',
  configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const url = (req.url || '').split('?')[0]
      const isJson = url === '/docs/' + LLM_EXPORT_JSON
      const isTxt = url === '/docs/' + LLM_EXPORT_TXT
      if (!isJson && !isTxt) return next()
      const sections = collectSections(process.cwd())
      res.setHeader(
        'Content-Type',
        isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      )
      res.end(isJson ? buildExportJson(sections) : buildExportText(sections))
    })
  },
}

// Top navigation. The Dev tab only appears in the flagged (admin) build.
const nav = [
  { text: 'Home', link: '/' },
  {
    text: 'Guide',
    link: '/authentication/login',
    activeMatch: '/(authentication|dashboard|matters|tasks|clients|leads|contacts|calendar|files|messaging|billing|trust|settings|templates|automation|document-signing)/',
  },
  ...(INCLUDE_DEV
    ? [
        { text: 'Dev', link: '/dev/', activeMatch: '/(dev|features)/' },
        { text: 'Future', link: '/future/', activeMatch: '/future/' },
      ]
    : []),
  { text: 'Export for AI', link: '/export' },
  { text: 'Back to App', link: 'https://paralegix.com' },
]

// Multi-sidebar: internal paths get the Dev sidebar, everything else the guide.
// Only wired up when the Dev content is part of the build.
const sidebar = INCLUDE_DEV
  ? {
      '/dev/': devSidebar,
      '/features/': devSidebar,
      '/future/': futureSidebar,
      '/STAGING_SETUP': devSidebar,
      '/TRUST_STRIPE_COMPLIANCE': devSidebar,
      '/DIRECT_CHARGE_MIGRATION': devSidebar,
      '/PRODUCTION_CUTOVER': devSidebar,
      '/': userGuideSidebar,
    }
  : userGuideSidebar

export default defineConfig({
  title: 'Paralegix',
  description: 'Legal practice management for modern law firms',
  base: '/docs/',

  // Keep internal/admin/engineering docs out of the public build entirely, and
  // keep the raw design specs out of every build.
  srcExclude: INCLUDE_DEV ? ALWAYS_EXCLUDE : [...ALWAYS_EXCLUDE, ...DEV_GLOBS],

  // After the site is built, emit the plain-text bundle and grouped JSON manifest
  // that power the "Export for AI" picker. Both respect the same public/dev split
  // as the site build.
  buildEnd: writeExportArtifacts,

  // Serve those same artifacts on the fly during `npm run dev` so the picker
  // works in development too (buildEnd only runs on `npm run build`).
  vite: {
    plugins: [exportDevServerPlugin],
  },

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/docs/favicon.svg' }],
    ['link', { rel: 'icon', type: 'image/x-icon', href: '/docs/favicon.ico' }],
  ],

  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: 'Paralegix Docs',

    nav,
    sidebar,

    socialLinks: [],

    footer: {
      message: 'Legal practice management for modern law firms.',
      copyright: `Copyright © ${new Date().getFullYear()} Paralegix`,
    },

    search,
  },
})
