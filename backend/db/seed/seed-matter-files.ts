/**
 * Seed a realistic file/folder tree into five matters' Files tabs.
 *
 *   npx tsx backend/db/seed/seed-matter-files.ts
 *   npx tsx backend/db/seed/seed-matter-files.ts --firm <lawFirmId> --owner <userId>
 *   npx tsx backend/db/seed/seed-matter-files.ts --list        # print the plan, write nothing
 *
 * Companion to seed-local-testdata.ts: that seeds the matters, this seeds their
 * documents. The five matters are found by the matter_number it assigns, so pass
 * the same `--firm` to both.
 *
 * The bytes are real PDFs read from `backend/db/seed/fixtures/` (gitignored, so
 * drop your own PDFs there), which makes previews, downloads and zip export
 * behave like production uploads. Every seeded document reuses one of those PDFs
 * under a matter-appropriate name.
 *
 * Writes exactly what the upload and create-folder routes write, through the
 * same `files.repository`:
 *   - one `files` row per folder and per file, joined by `parent_id`
 *   - one GCS object per file, at the opaque `object_path` the row was given
 *   - the firm's storage-usage counter, adjusted by the net bytes written
 *
 * A folder has no object of its own: it is a row and nothing else. The old
 * `.folder` marker objects are gone with the object-path-keyed model.
 *
 * Idempotent: a re-run deletes the folders this script owns by name, along with
 * everything under them, then rebuilds. Files a person uploaded into the same
 * matters under other folders are left alone.
 *
 * seed-matter-details.ts also seeds files, and its folder names overlap these.
 * Whichever runs last owns the overlapping folders in the matters they share.
 * This one goes deeper, so run it after that one, not before.
 *
 * Refuses to run against a hosted Supabase database.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { admin } = require('../../src/shared/database/firebase');
// db.ts exports the pool and nothing else; there is no bare `query` helper.
const { pool } = require('../../src/shared/database/db');
const { resolveDbUrl } = require('../../src/shared/database/resolveDbUrl');
const filesRepo = require('../../src/modules/files/files.repository');
const { adjustStorageUsageByDelta } = require('../../src/shared/utils/storageUsage');
const { loadFixtures, seedMatterFiles } = require('./seedFiles');

const DEFAULT_FIRM = '271a8a01-12fe-534a-9a5e-d2d0cbc72a8b';
const DEFAULT_OWNER = 'rioHoxMeFbTIy7dW9CsNrnKUBYZ2';

const argOf = (flag: any, fallback: any) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const FIRM = argOf('--firm', DEFAULT_FIRM);
const OWNER = argOf('--owner', DEFAULT_OWNER);
const LIST_ONLY = process.argv.includes('--list');

const BUCKET_NAME = process.env.GCS_BUCKET || 'lawfirms';
const bucket = admin.storage().bucket(BUCKET_NAME);

// Stamped on every object this script writes; the cleanup pass deletes only
// objects carrying it, so hand-uploaded files in the same matters survive a re-run.
const SEED_MARK = 'seed-matter-files';

// Matters are found by their matter_number, which seed-local-testdata.ts sets
// deterministically. Their ids are NOT stable: that script folds a per-firm hash
// into every id it generates, so the same matter has a different id in every firm.

// ── fixture PDFs ────────────────────────────────────────────────────────────
// Keys are the *kind* of document; each maps to a file in the fixtures dir. When
// a named fixture is absent the loader falls back to cycling whatever PDFs are
// there, so the tree still seeds with an arbitrary set of sample files.
const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const FIXTURE_FILES = {
  appearance: 'notice-of-appearance-a.pdf',
  appearance2: 'notice-of-appearance-b.pdf',
  agreement: 'representation-agreement-signed.pdf',
};

// ── the tree ────────────────────────────────────────────────────────────────
// `folders` are created in order, so a nested folder's parent always exists first.
// A file's `folder` is the path under the matter root ('' = the matter's root).
// `visible: true` shares the file (or folder) with the client portal, exactly as
// the share toggle in the UI does.
const PLAN = [
  {
    matterNumber: 'TEST-2026-001',
    label: 'Whitfield v. Ridgeline Transport',
    folders: [
      { path: 'Pleadings', color: 'blue' },
      { path: 'Discovery', color: 'purple' },
      { path: 'Discovery/Medical Records', color: 'teal' },
      { path: 'Correspondence', color: 'green' },
      { path: 'Client Documents', color: 'amber', visible: true },
    ],
    files: [
      { folder: '', name: 'Matter Intake Summary.pdf', fixture: 'appearance' },
      { folder: 'Pleadings', name: 'Complaint.pdf', fixture: 'appearance' },
      { folder: 'Pleadings', name: 'Notice of Appearance.pdf', fixture: 'appearance' },
      { folder: 'Pleadings', name: 'Answer of Ridgeline Transport.pdf', fixture: 'appearance2' },
      { folder: 'Discovery', name: 'Plaintiff First Set of Interrogatories.pdf', fixture: 'appearance2' },
      { folder: 'Discovery', name: 'Requests for Production.pdf', fixture: 'appearance' },
      { folder: 'Discovery/Medical Records', name: 'OSU Medical Center Records.pdf', fixture: 'appearance2' },
      { folder: 'Discovery/Medical Records', name: 'Radiology Report 03-14.pdf', fixture: 'appearance' },
      { folder: 'Correspondence', name: 'Policy Limits Demand Letter.pdf', fixture: 'agreement', visible: true },
      { folder: 'Correspondence', name: 'Meridian Casualty Acknowledgment.pdf', fixture: 'appearance2' },
      { folder: 'Client Documents', name: 'Representation Agreement - Signed.pdf', fixture: 'agreement', visible: true },
      { folder: 'Client Documents', name: 'HIPAA Authorization.pdf', fixture: 'appearance', visible: true },
    ],
  },
  {
    matterNumber: 'TEST-2026-009',
    label: 'Raman Trademark Dispute',
    folders: [
      { path: 'TTAB Filings', color: 'blue' },
      { path: 'Evidence', color: 'purple' },
      { path: 'Evidence/Specimens', color: 'fuchsia' },
      { path: 'Correspondence', color: 'green' },
    ],
    files: [
      { folder: '', name: 'Engagement Letter - Signed.pdf', fixture: 'agreement', visible: true },
      { folder: 'TTAB Filings', name: 'Notice of Opposition.pdf', fixture: 'appearance' },
      { folder: 'TTAB Filings', name: 'Answer to Opposition.pdf', fixture: 'appearance2' },
      { folder: 'TTAB Filings', name: 'Notice of Appearance.pdf', fixture: 'appearance' },
      { folder: 'Evidence', name: 'Trademark Search Report.pdf', fixture: 'appearance2' },
      { folder: 'Evidence', name: 'Priority Use Declaration.pdf', fixture: 'appearance' },
      { folder: 'Evidence/Specimens', name: 'Packaging Specimen 2024.pdf', fixture: 'appearance2' },
      { folder: 'Evidence/Specimens', name: 'Website Specimen Capture.pdf', fixture: 'appearance' },
      { folder: 'Correspondence', name: 'Cease and Desist Letter.pdf', fixture: 'appearance2' },
      { folder: 'Correspondence', name: 'Opposing Counsel Reply.pdf', fixture: 'appearance' },
    ],
  },
  {
    matterNumber: 'TEST-2026-010',
    label: 'Delgado Freight - DOT Compliance Audit',
    folders: [
      { path: 'Audit Response', color: 'orange' },
      { path: 'Driver Qualification Files', color: 'teal' },
      { path: 'Corrective Action Plan', color: 'red' },
    ],
    files: [
      { folder: '', name: 'DOT Audit Notice.pdf', fixture: 'appearance' },
      { folder: '', name: 'Flat Fee Agreement - Signed.pdf', fixture: 'agreement', visible: true },
      { folder: 'Audit Response', name: 'Response Cover Letter.pdf', fixture: 'appearance2' },
      { folder: 'Audit Response', name: 'Hours of Service Logs Summary.pdf', fixture: 'appearance' },
      { folder: 'Audit Response', name: 'Maintenance Records Index.pdf', fixture: 'appearance2' },
      { folder: 'Driver Qualification Files', name: 'DQF - R. Alvarez.pdf', fixture: 'appearance' },
      { folder: 'Driver Qualification Files', name: 'DQF - T. Nguyen.pdf', fixture: 'appearance2' },
      { folder: 'Driver Qualification Files', name: 'DQF - M. Boateng.pdf', fixture: 'appearance' },
      { folder: 'Corrective Action Plan', name: 'Draft Corrective Action Plan.pdf', fixture: 'appearance2' },
      { folder: 'Corrective Action Plan', name: 'Driver Training Schedule.pdf', fixture: 'appearance' },
    ],
  },
  {
    matterNumber: 'TEST-2026-003',
    label: 'Bello Dissolution',
    folders: [
      { path: 'Pleadings', color: 'blue' },
      { path: 'Financial Disclosures', color: 'red' },
      { path: 'Financial Disclosures/Bank Statements', color: 'yellow' },
      { path: 'Parenting', color: 'fuchsia' },
      { path: 'Client Documents', color: 'amber', visible: true },
    ],
    files: [
      { folder: 'Pleadings', name: 'Petition for Dissolution.pdf', fixture: 'appearance' },
      { folder: 'Pleadings', name: 'Notice of Appearance.pdf', fixture: 'appearance2' },
      { folder: 'Pleadings', name: 'Temporary Orders Motion.pdf', fixture: 'appearance' },
      { folder: 'Financial Disclosures', name: 'Affidavit of Income and Expenses.pdf', fixture: 'appearance2' },
      { folder: 'Financial Disclosures', name: 'Business Valuation Summary.pdf', fixture: 'appearance' },
      { folder: 'Financial Disclosures/Bank Statements', name: 'Joint Checking Q1.pdf', fixture: 'appearance2' },
      { folder: 'Financial Disclosures/Bank Statements', name: 'Joint Checking Q2.pdf', fixture: 'appearance' },
      { folder: 'Parenting', name: 'Proposed Parenting Plan.pdf', fixture: 'appearance2' },
      { folder: 'Parenting', name: 'School Calendar Overlay.pdf', fixture: 'appearance' },
      { folder: 'Client Documents', name: 'Representation Agreement - Signed.pdf', fixture: 'agreement', visible: true },
      { folder: 'Client Documents', name: 'Client Questionnaire.pdf', fixture: 'appearance', visible: true },
    ],
  },
  {
    matterNumber: 'TEST-2026-005',
    label: 'State v. Okafor',
    folders: [
      { path: 'Pleadings', color: 'blue' },
      { path: 'Discovery', color: 'purple' },
      { path: 'Discovery/Dashcam and CAD', color: 'teal' },
      { path: 'Client Documents', color: 'amber', visible: true },
    ],
    files: [
      { folder: '', name: 'Case Summary and Timeline.pdf', fixture: 'appearance' },
      { folder: 'Pleadings', name: 'Notice of Appearance.pdf', fixture: 'appearance' },
      { folder: 'Pleadings', name: 'Motion to Suppress.pdf', fixture: 'appearance2' },
      { folder: 'Pleadings', name: 'Memorandum in Support.pdf', fixture: 'appearance' },
      { folder: 'Discovery', name: 'State Discovery Packet.pdf', fixture: 'appearance2' },
      { folder: 'Discovery', name: 'Breath Test Calibration Records.pdf', fixture: 'appearance' },
      { folder: 'Discovery/Dashcam and CAD', name: 'CAD Log Request.pdf', fixture: 'appearance2' },
      { folder: 'Discovery/Dashcam and CAD', name: 'Dashcam Transcript.pdf', fixture: 'appearance' },
      { folder: 'Client Documents', name: 'Flat Fee Agreement - Signed.pdf', fixture: 'agreement', visible: true },
    ],
  },
];

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL resolved (DB_TARGET / DATABASE_URL in backend/.env).');
    process.exit(1);
  }
  if (/supabase|pooler\.supabase\.com/i.test(connectionString)) {
    console.error('Refusing to run: this resolves to a hosted Supabase database.');
    console.error('Set DB_TARGET=local (or pass DB_TARGET=local inline) and retry.');
    process.exit(1);
  }

  if (LIST_ONLY) {
    for (const m of PLAN) {
      console.log(`\n${m.label}  (${m.matterNumber})`);
      for (const f of m.folders) console.log(`  [dir]  ${f.path}${f.color ? `  (${f.color})` : ''}${f.visible ? '  shared' : ''}`);
      for (const f of m.files) console.log(`  [file] ${f.folder ? `${f.folder}/` : ''}${f.name}${f.visible ? '  shared' : ''}`);
    }
    const files = PLAN.reduce((n, m) => n + m.files.length, 0);
    const folders = PLAN.reduce((n, m) => n + m.folders.length, 0);
    console.log(`\n${PLAN.length} matters, ${folders} folders, ${files} files. Nothing written (--list).`);
    return;
  }

  const fixtures = loadFixtures(FIXTURE_DIR, FIXTURE_FILES);

  const { rows: firmRows } = await pool.query('select id, name from law_firms where id = $1', [FIRM]);
  if (firmRows.length === 0) {
    console.error(`Law firm ${FIRM} not found in this database.`);
    process.exit(1);
  }

  const { rows: matterRows } = await pool.query(
    'select id, name, matter_number from matters where law_firm_id = $1 and matter_number = any($2::text[])',
    [FIRM, PLAN.map((m) => m.matterNumber)],
  );
  const idByNumber = new Map(matterRows.map((r: any) => [r.matter_number, r.id]));
  const missing = PLAN.filter((m) => !idByNumber.has(m.matterNumber));
  if (missing.length > 0) {
    console.error('These matters do not exist. Run seed-local-testdata.ts against this firm first:');
    for (const m of missing) console.error(`  ${m.label} (${m.matterNumber})`);
    process.exit(1);
  }

  console.log(`Firm: ${firmRows[0].name} (${FIRM})`);
  console.log(`Bucket: ${BUCKET_NAME}\n`);

  let addedBytes = 0;
  let removedBytes = 0;
  let fileCount = 0;
  let folderCount = 0;

  for (const matter of PLAN) {
    const res = await seedMatterFiles({
      bucket,
      filesRepo,
      query: (text: string, params?: any[]) => pool.query(text, params),
      lawFirmId: FIRM,
      matterId: idByNumber.get(matter.matterNumber),
      actor: OWNER,
      folders: matter.folders,
      plan: matter.files,
      fixtures,
      seedMark: SEED_MARK,
    });
    addedBytes += res.addedBytes;
    removedBytes += res.removedBytes;
    fileCount += matter.files.length;
    folderCount += matter.folders.length;

    const replaced = res.removedBytes > 0 ? ', replacing the previous run' : '';
    console.log(`${matter.label}: ${matter.folders.length} folders, ${matter.files.length} files${replaced}`);
  }

  await adjustStorageUsageByDelta(FIRM, addedBytes - removedBytes);

  const mb = (addedBytes / 1024 / 1024).toFixed(1);
  console.log(`\nSeeded ${fileCount} files and ${folderCount} folders across ${PLAN.length} matters (${mb} MB).`);
  console.log('Open a matter, then Files, to see them.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
