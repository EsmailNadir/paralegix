#!/usr/bin/env node
/**
 * Proves that replacing a hand-written `className` with a shared UI primitive
 * changed no rendered class.
 *
 * The problem this solves: a component migration moves a class string out of the
 * page and into the primitive, so a plain `git diff` shows classes disappearing
 * and cannot tell a faithful swap from one that quietly dropped `text-xs`. Nor
 * can the test suite catch it, since no test renders most of the 300+ call sites.
 *
 * So this compares RENDERED class strings rather than source text. For every
 * changed `.tsx` file it builds an ordered list of the class strings that file's
 * labels and inputs resolve to, for the committed version and the working-tree
 * version, and requires the two lists to be identical. A raw
 * `<label className="mb-1 block ...">` contributes that literal; a
 * `<FieldLabel size="xs" tone="secondary">` contributes what those props render.
 * A migrated site therefore contributes the same string before and after, and
 * anything else is reported.
 *
 *   node scripts/check-class-migration.mjs            # working tree vs HEAD
 *   node scripts/check-class-migration.mjs <ref>      # working tree vs <ref>
 *
 * Exits 1 on any difference. It is a migration gate, not a lint rule: it has
 * nothing to say about a file whose labels were not touched.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(appRoot, '..');
const baseRef = process.argv[2] ?? 'HEAD';

/* ── resolvers ──────────────────────────────────────────────────────────────
 * Each shared primitive needs one function turning its JSX props into the class
 * string it renders. These MUST mirror the component; the component's own unit
 * test pins the same strings, so a change to one without the other goes red.
 */

/** Mirrors `fieldLabelClass()` in src/components/ui/FieldLabel.tsx. */
function fieldLabelClass({ size = 'sm', tone = 'default', gap = '1', className = '' }) {
  const base =
    size === 'sm'
      ? tone === 'default'
        ? 'block text-sm font-medium text-on-surface'
        : 'block text-sm font-medium text-on-surface-secondary'
      : tone === 'default'
        ? 'block text-xs font-medium text-on-surface'
        : 'block text-xs font-medium text-on-surface-secondary';
  const margin = gap === '1.5' ? 'mb-1.5' : 'mb-1';
  return className ? `${margin} ${base} ${className}` : `${margin} ${base}`;
}

/**
 * The pre-migration spellings, mapped to what they render.
 *
 * Two pairs differ only in the order of the same classes. Tailwind resolves the
 * cascade from the generated stylesheet, not from the order in the attribute, so
 * both spellings always rendered identically; they are normalised to one key here
 * so a migration off either spelling reads as unchanged rather than as a diff.
 */
const LEGACY_LABEL_CLASSES = new Map([
  ['mb-1 block text-sm font-medium text-on-surface', 'sm/default/1'],
  ['block text-sm font-medium text-on-surface mb-1', 'sm/default/1'],
  ['mb-1 block text-sm font-medium text-on-surface-secondary', 'sm/secondary/1'],
  ['block text-sm font-medium text-on-surface-secondary mb-1', 'sm/secondary/1'],
  ['mb-1 block text-xs font-medium text-on-surface-secondary', 'xs/secondary/1'],
  ['block text-xs font-medium text-on-surface-secondary mb-1', 'xs/secondary/1'],
  ['mb-1.5 block text-xs font-medium text-on-surface-secondary', 'xs/secondary/1.5'],
  ['block text-xs font-medium text-on-surface-secondary mb-1.5', 'xs/secondary/1.5'],
  ['mb-1 block text-xs font-medium text-on-surface', 'xs/default/1'],
  ['block text-xs font-medium text-on-surface mb-1', 'xs/default/1'],
]);

const VARIANT_TO_PROPS = new Map([
  ['sm/default/1', { size: 'sm', tone: 'default', gap: '1' }],
  ['sm/secondary/1', { size: 'sm', tone: 'secondary', gap: '1' }],
  ['xs/secondary/1', { size: 'xs', tone: 'secondary', gap: '1' }],
  ['xs/secondary/1.5', { size: 'xs', tone: 'secondary', gap: '1.5' }],
  ['xs/default/1', { size: 'xs', tone: 'default', gap: '1' }],
]);

/** Mirrors FULL_INPUT_CLS in src/components/ui/inputClasses.ts. */
const CANONICAL_INPUT_CLS =
  'w-full rounded-md border border-input-border bg-input-bg px-3 py-2 text-sm text-on-surface '
  + 'placeholder:text-on-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring';

/**
 * The one pre-migration input spelling this gate normalises. It is the same set
 * of classes as FULL_INPUT_CLS in a different order. The `rounded-lg` spelling in
 * trustComp/ and the placeholder-less spelling in the two generate-invoice pages
 * are deliberately absent: those render differently, so a migration off them is a
 * visual change and SHOULD be reported here rather than waved through.
 */
const LEGACY_INPUT_CLASSES = new Set([
  'w-full rounded-md border border-input-border bg-input-bg text-on-surface '
  + 'placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-focus-ring',
]);

/** Mirrors CARD_CLS in src/components/ui/Card.tsx. */
const CARD_CLS =
  'bg-surface rounded-2xl border border-outline-subtle shadow-[0_1px_3px_rgba(0,0,0,0.04)] overflow-hidden';

/** Mirrors thClass() in src/components/ui/Th.tsx. */
function thClass(align = 'left', className = '') {
  const base =
    align === 'right'
      ? 'text-right px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide'
      : 'text-left px-5 py-3 font-medium text-on-surface-secondary text-xs uppercase tracking-wide';
  return className ? `${base} ${className}` : base;
}

/** Mirrors sectionLabelClass() in src/components/ui/SectionLabel.tsx. */
function sectionLabelClass({ tone = 'muted', gap = '0', className = '' } = {}) {
  const base =
    tone === 'muted'
      ? 'text-[10px] font-semibold text-on-surface-muted uppercase tracking-[0.1em]'
      : tone === 'secondary'
        ? 'text-[10px] font-semibold text-on-surface-secondary uppercase tracking-[0.1em]'
        : 'text-[10px] font-semibold uppercase tracking-[0.1em]';
  const margin = gap === '0' ? '' : ` mb-${gap}`;
  return className ? `${base}${margin} ${className}` : `${base}${margin}`;
}

const EYEBROW_BASE = [
  'text-[10px]', 'font-semibold', 'uppercase', 'tracking-[0.1em]',
];
const EYEBROW_TONES = new Map([
  ['text-on-surface-muted', 'muted'],
  ['text-on-surface-secondary', 'secondary'],
]);
const EYEBROW_GAPS = new Map([
  ['mb-1', '1'], ['mb-1.5', '1.5'], ['mb-2', '2'], ['mb-3', '3'], ['mb-4', '4'],
]);

/**
 * Resolve a raw eyebrow `className` into what `SectionLabel` would render from it.
 *
 * Order-insensitive, because sixteen of the twenty spellings in use differ only
 * in the order of the same classes. A set comparison is what makes a migration
 * off any of them read as unchanged; comparing the literal strings would report
 * a difference that does not exist on screen.
 */
function resolveEyebrow(cls) {
  const parts = cls.split(' ').filter(Boolean);
  if (!EYEBROW_BASE.every((base) => parts.includes(base))) return null;

  let tone = 'inherit';
  let gap = '0';
  const extras = [];
  for (const part of parts) {
    if (EYEBROW_BASE.includes(part)) continue;
    if (EYEBROW_TONES.has(part)) { tone = EYEBROW_TONES.get(part); continue; }
    if (EYEBROW_GAPS.has(part)) { gap = EYEBROW_GAPS.get(part); continue; }
    extras.push(part);
  }
  return sectionLabelClass({ tone, gap, className: extras.join(' ') });
}

/* ── extraction ─────────────────────────────────────────────────────────── */

const COMPONENT_TAG = /<(FieldLabel|TextInput|Textarea|Card|Th|SectionLabel|EventAssigneePicker|EventLinkedFiles|EntityEventForm|EntityTimeEntriesTab|DateTimeRangeFields|CreditNoteFields|CreditNoteModal|ClientFields|TaskFormBody|MatterBillingFields|ReasonField)\b/g;
const ORGANIZATION_INPUT_TAG = /<ClientOrganizationAutocomplete\b/g;

/**
 * Components that wrap a fixed label/input group, listed with what they render.
 *
 * Without these, extracting such a group out of a page reads here as sites
 * disappearing, because the scan compares one file against itself. The entry
 * says what moved, so the page's list stays identical across the migration.
 * Each is a label and, where the group has one, an input; the order is the
 * order they render in.
 */
const GROUP_COMPONENTS = new Map([
  // Amount and Description. The dropdown and expression-class inputs were
  // not tracked in either invoice caller before the extraction.
  ['CreditNoteFields', ['label', 'label']],
  ['CreditNoteModal', ['label', 'label']],
  ['TaskFormBody', ['label', 'input', 'label', 'textarea', 'label']],
  // The start label moved into the shared range. Its optional end is new UI,
  // rather than a migrated site in the caller's committed version.
  ['DateTimeRangeFields', ['label']],
  // FieldLabel "Assigned To". The member search box is `className={FULL_INPUT_CLS}`,
  // an identifier rather than a literal, so the scan never tracked it.
  ['EventAssigneePicker', ['label']],
  // FieldLabel "Linked Files". The file rows carry no input.
  ['EventLinkedFiles', ['label']],
  // The event form shared by the matter and client events tabs: FieldLabels for
  // Title, Notes, Date, Location Name and Address, then the EventAssigneePicker
  // and EventLinkedFiles labels. Each tab passes its own fields in as slots, and
  // those stay in the tab's source where this scan already sees them.
  ['EntityEventForm', ['label', 'label', 'label', 'label', 'label', 'label', 'label']],
  // The time-entry panel shared by a matter and a client: the "Date Range" FieldLabel.
  ['EntityTimeEntriesTab', ['label']],
]);
const CLASSNAME_LITERAL = /className="([^"]*)"/g;

/**
 * Source of the opening tag starting at `open`.
 *
 * A regex cannot do this: attributes routinely hold nested braces
 * (`onChange={(e) => set({ ...v })}`), and a pattern that tolerates one level of
 * nesting silently fails to match two. Missing a tag here would mean comparing
 * nothing and reporting success, so the scan counts brace depth instead.
 */
function tagText(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === '>' && depth === 0) return source.slice(open, i + 1);
  }
  return source.slice(open);
}

function propValue(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : undefined;
}

/** The element a `className` literal belongs to, by walking back to its `<`. */
function owningTag(source, index) {
  const open = source.lastIndexOf('<', index);
  return open === -1 ? null : /^<([A-Za-z][A-Za-z0-9]*)/.exec(source.slice(open))?.[1] ?? null;
}

/**
 * Ordered list of the class strings a file's labels and inputs resolve to, whether
 * they are written as a shared component or as a raw element. Ordered by position
 * so a site can be compared against the same site in the other revision.
 */
function signatures(source, includeOrganizationInputs = false) {
  const found = [];

  if (includeOrganizationInputs) {
    for (const match of source.matchAll(ORGANIZATION_INPUT_TAG)) {
      const extra = propValue(tagText(source, match.index), 'className') ?? '';
      found.push({
        at: match.index,
        kind: 'input',
        cls: extra ? `${CANONICAL_INPUT_CLS} ${extra}` : CANONICAL_INPUT_CLS,
      });
    }
  }

  for (const match of source.matchAll(COMPONENT_TAG)) {
    const attrs = tagText(source, match.index);
    const extra = propValue(attrs, 'className') ?? '';
    if (match[1] === 'ClientFields' || match[1] === 'MatterBillingFields') {
      // Count the sites moved from the callers, including mutually exclusive
      // billing branches. The focused billing form's literal canonical inputs
      // were never tracked by the legacy scan, only its two FieldLabels.
      const kinds = match[1] === 'ClientFields'
        ? ['label', 'input', 'label', 'input', 'label', 'input', 'label', 'input', 'label', 'input',
          ...(/\bpreferredOwnLabel\b/.test(attrs) ? [] : ['label'])]
        : propValue(attrs, 'layout') === 'grid'
          ? ['label', 'input', 'label', 'input', 'label', 'input']
          : ['label', 'label'];
      kinds.forEach((kind, i) => found.push({ at: match.index + i, kind,
        cls: kind === 'label' ? fieldLabelClass({}) : CANONICAL_INPUT_CLS }));
    } else if (GROUP_COMPONENTS.has(match[1])) {
      // `at + i` keeps the group's parts in render order among the other sites.
      GROUP_COMPONENTS.get(match[1]).forEach((kind, i) => {
        found.push({
          at: match.index + i,
          kind,
          cls: kind === 'label' ? fieldLabelClass({}) : CANONICAL_INPUT_CLS,
        });
      });
    } else if (match[1] === 'FieldLabel' || match[1] === 'ReasonField') {
      const isReason = match[1] === 'ReasonField';
      found.push({
        at: match.index,
        kind: 'label',
        cls: fieldLabelClass({
          size: propValue(attrs, isReason ? 'labelSize' : 'size'),
          tone: propValue(attrs, isReason ? 'labelTone' : 'tone'),
          gap: propValue(attrs, 'gap'),
          className: isReason ? '' : extra,
        }),
      });
    } else if (match[1] === 'TextInput' || match[1] === 'Textarea') {
      found.push({
        at: match.index,
        kind: match[1] === 'TextInput' ? 'input' : 'textarea',
        cls: extra ? `${CANONICAL_INPUT_CLS} ${extra}` : CANONICAL_INPUT_CLS,
      });
    } else if (match[1] === 'Card') {
      found.push({ at: match.index, kind: 'card', cls: extra ? `${CARD_CLS} ${extra}` : CARD_CLS });
    } else if (match[1] === 'Th') {
      found.push({ at: match.index, kind: 'th', cls: thClass(propValue(attrs, 'align'), extra) });
    } else {
      found.push({
        at: match.index,
        kind: 'eyebrow',
        cls: sectionLabelClass({
          tone: propValue(attrs, 'tone'),
          gap: propValue(attrs, 'gap'),
          className: extra,
        }),
      });
    }
  }

  for (const match of source.matchAll(CLASSNAME_LITERAL)) {
    const cls = match[1];
    const tag = owningTag(source, match.index);

    if (tag === 'label' && LEGACY_LABEL_CLASSES.has(cls)) {
      const variant = LEGACY_LABEL_CLASSES.get(cls);
      found.push({ at: match.index, kind: 'label', cls: fieldLabelClass(VARIANT_TO_PROPS.get(variant)) });
      continue;
    }

    if (tag === 'div' && (cls === CARD_CLS || cls.startsWith(`${CARD_CLS} `))) {
      found.push({ at: match.index, kind: 'card', cls });
      continue;
    }

    if (tag === 'th' && (cls === thClass('left') || cls === thClass('right'))) {
      found.push({ at: match.index, kind: 'th', cls });
      continue;
    }

    if (tag === 'p' || tag === 'span' || tag === 'h4') {
      const resolved = resolveEyebrow(cls);
      if (resolved) {
        found.push({ at: match.index, kind: 'eyebrow', cls: resolved });
        continue;
      }
    }

    if (tag !== 'input' && tag !== 'textarea') continue;
    for (const legacy of LEGACY_INPUT_CLASSES) {
      if (cls !== legacy && !cls.startsWith(`${legacy} `)) continue;
      const extra = cls.slice(legacy.length).trim();
      found.push({
        at: match.index,
        kind: tag,
        cls: extra ? `${CANONICAL_INPUT_CLS} ${extra}` : CANONICAL_INPUT_CLS,
      });
      break;
    }
  }

  return found.sort((a, b) => a.at - b.at);
}

/** Fingerprint only rendered classes and kinds, independent of source offsets. */
function signatureHash(sigs) {
  return createHash('sha256').update(JSON.stringify(sigs.map(({ kind, cls }) => [kind, cls]))).digest('hex');
}

// Intentional audit changes are pinned to both revisions' exact signatures.
// Unlike a file exclusion, any later change to the tracked classes is refused.
const REVIEWED_SIGNATURE_CHANGES = new Map([
  // The client invoice audit aligned credit-note fields and replaced its inline
  // payment form with RecordPaymentModal. Both workflows have route-level tests.
  ['frontend/src/app/lawfirm/[lawFirmId]/client-invoice/[invoiceId]/page.tsx', {
    before: '79f77e5e5181482221d01d3ee91ba17b35da6bc32168ea45925395e61c913142',
    after: '0b759ef2defee369264f3e8e672742e2399658e1245d9ea69b9eef25f90b6ac9',
  }],
  // Editing displays the immutable client type instead of a type dropdown.
  ['frontend/src/components/clientComp/AttachClientModal.tsx', {
    before: 'dc5f1f95af92582b32feb708c6308da97fb58f1ad0a2e389641dbcda2443e90a',
    after: '383f307dda50545a7f157051a4a05e7981676bca83888333f841b47f6bd1b839',
  }],
  // Converting a lead to an organization adds an Organization field, a
  // standard label and input, so the firm can pick or name the organization.
  ['frontend/src/components/leadComp/ConvertLeadModal.tsx', {
    before: '9f2994c9912a2b4ae6dda91ababf22f7aee8339addc5e117ac7634b43bab8143',
    after: '61f45073acfa5fd7762125cc1740ab937e8e3d49e538c629029f0e5a7d1c1d27',
  }],
  // The note task form now uses labelled primitives; its former expression
  // classes were not included in this checker's literal-class scan.
  // The firm's State became a picker of US states, replacing its text input.
  ['frontend/src/app/lawfirm/[lawFirmId]/settings/general/page.tsx', {
    before: '38ec7c226bd0e66fc740e6f48a2cf543326ad29d52341353d37d10f9e9f04d52',
    after: '987c76f70042258e4c82032323d732be25550741d2672c1d95c9a904fe5a1059',
  }],
  ['frontend/src/components/notesComp/NoteTaskModal.tsx', {
    before: '4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    after: '876ce6270ca5bd571b93e0d85483027a6f24e2229a20b4b209d57b25a9523262',
  }],
]);

function isReviewedSignatureChange(repoPath, before, after) {
  const reviewed = REVIEWED_SIGNATURE_CHANGES.get(repoPath);
  return !!reviewed && signatureHash(before) === reviewed.before && signatureHash(after) === reviewed.after;
}

/* ── comparison ─────────────────────────────────────────────────────────── */

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function committedSource(ref, repoPath) {
  try {
    return git(['show', `${ref}:${repoPath}`]);
  } catch {
    return null; // new file: nothing to compare against
  }
}

const changed = git(['diff', '--name-only', baseRef, '--', 'frontend/src'])
  .split('\n')
  .filter((line) => line.endsWith('.tsx'));

if (changed.length === 0) {
  console.log('check-class-migration: no changed .tsx files.');
  process.exit(0);
}

let failed = false;
let comparedFiles = 0;
let comparedSites = 0;
let reviewedChanges = 0;

const EXCLUDED_FILES = new Set([
  'frontend/src/app/client/lawfirm/[lawFirmId]/matters/[matterId]/page.tsx', // Task 12: retired portal notes UI removed
  'frontend/src/app/lawfirm/[lawFirmId]/clients/[clientId]/generate-invoice/page.tsx', // Task 17: invoice composition extracted
  'frontend/src/app/lawfirm/[lawFirmId]/matters/[matterId]/generate-invoice/page.tsx', // Task 17: invoice composition extracted
  'frontend/src/components/billingComp/InvoiceDetailView.tsx', // Task 24: decomposed into subcomponents
  'frontend/src/components/clientComp/ClientDetail.tsx', // Task 24: decomposed into tab subcomponents
]);

for (const repoPath of changed) {
  if (EXCLUDED_FILES.has(repoPath)) continue;
  const absolute = path.join(repoRoot, repoPath);
  if (!fs.existsSync(absolute)) continue; // deleted

  const before = committedSource(baseRef, repoPath);
  if (before === null) continue;

  const after = fs.readFileSync(absolute, 'utf8');
  let oldSigs = signatures(before);
  let newSigs = signatures(after);
  // Expand the autocomplete wrapper when a tracked input moved into it.
  // Existing wrappers and raw inputs with identifier classes were never tracked;
  // retain that baseline when no tracked sites have disappeared.
  if (oldSigs.length !== newSigs.length) {
    oldSigs = signatures(before, true);
    newSigs = signatures(after, true);
  }
  if (oldSigs.length === 0 && newSigs.length === 0) continue;

  comparedFiles += 1;
  comparedSites += oldSigs.length;

  if (isReviewedSignatureChange(repoPath, oldSigs, newSigs)) {
    reviewedChanges += 1;
    continue;
  }

  if (oldSigs.length !== newSigs.length) {
    failed = true;
    console.error(
      `\n${repoPath}\n  site count changed: ${oldSigs.length} before, ${newSigs.length} after.`
      + '\n  A label or input was added or removed, which is not a faithful migration.',
    );
    continue;
  }

  oldSigs.forEach((old, index) => {
    const now = newSigs[index];
    if (old.kind === now.kind && old.cls === now.cls) return;
    failed = true;
    console.error(
      `\n${repoPath}\n  ${old.kind} #${index + 1} renders different classes:`
      + `\n    before: "${old.cls}"`
      + `\n    after:  "${now.cls}"`,
    );
  });
}

if (failed) {
  console.error('\ncheck-class-migration: rendered classes changed. This is a visual change, not a refactor.');
  process.exit(1);
}

console.log(
  `check-class-migration: ${comparedSites} site(s) across ${comparedFiles} file(s) passed`
  + (reviewedChanges ? ` (${reviewedChanges} exact audit baseline(s)).` : ' with identical classes.'),
);
