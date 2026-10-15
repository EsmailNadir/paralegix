/**
 * Import the US courts directory into the global court_catalog from the
 * CourtListener (Free Law Project) REST API.
 *
 *   npx tsx backend/db/seed/import-courts.ts
 *   DB_TARGET=staging npx tsx backend/db/seed/import-courts.ts
 *
 * The database is chosen the same way the server chooses it: DB_TARGET selects
 * DATABASE_URL_LOCAL / _STAGING / _PROD, falling back to DATABASE_URL.
 * Idempotent: upserts on unique (source, source_id). Re-run to refresh.
 * Loads env from backend/.env. Requires network access to courtlistener.com.
 * Optional: set COURTLISTENER_TOKEN in .env for higher rate limits.
 *
 * court_catalog is global (no law_firm_id) — this is the only writer for
 * source='courtlistener'. The import is intentionally source-agnostic at the
 * DB layer: a different dataset can be loaded by writing another importer that
 * targets court_catalog with its own `source` value.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { Client } = require('pg');
const { resolveDbUrl, needsSsl } = require('../../src/shared/database/resolveDbUrl');

const API_BASE = 'https://www.courtlistener.com/api/rest/v4/courts/';
const SOURCE = 'courtlistener';

// CourtListener jurisdiction code -> { jurisdiction, court_type }.
// Codes per the Free Law Project Court model.
const JURISDICTION_MAP: Record<string, { jurisdiction: string; court_type: string }> = {
  F:   { jurisdiction: 'federal', court_type: 'appellate' },
  FD:  { jurisdiction: 'federal', court_type: 'district' },
  FB:  { jurisdiction: 'federal', court_type: 'bankruptcy' },
  FBP: { jurisdiction: 'federal', court_type: 'bankruptcy_panel' },
  FS:  { jurisdiction: 'federal', court_type: 'special' },
  S:   { jurisdiction: 'state',   court_type: 'supreme' },
  SA:  { jurisdiction: 'state',   court_type: 'appellate' },
  ST:  { jurisdiction: 'state',   court_type: 'trial' },
  SS:  { jurisdiction: 'state',   court_type: 'special' },
  SAG: { jurisdiction: 'state',   court_type: 'attorney_general' },
  TRS: { jurisdiction: 'tribal',  court_type: 'supreme' },
  TRA: { jurisdiction: 'tribal',  court_type: 'appellate' },
  TRT: { jurisdiction: 'tribal',  court_type: 'trial' },
  TRX: { jurisdiction: 'tribal',  court_type: 'special' },
  TS:  { jurisdiction: 'territory', court_type: 'supreme' },
  TA:  { jurisdiction: 'territory', court_type: 'appellate' },
  TT:  { jurisdiction: 'territory', court_type: 'trial' },
  TSP: { jurisdiction: 'territory', court_type: 'special' },
  MA:  { jurisdiction: 'military', court_type: 'appellate' },
  MT:  { jurisdiction: 'military', court_type: 'trial' },
  C:   { jurisdiction: 'other', court_type: 'committee' },
  I:   { jurisdiction: 'other', court_type: 'international' },
  T:   { jurisdiction: 'other', court_type: 'testing' },
};

function mapJurisdiction(code: any) {
  return JURISDICTION_MAP[code] || { jurisdiction: null, court_type: null };
}

function buildHeaders() {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (process.env.COURTLISTENER_TOKEN) {
    headers.Authorization = `Token ${process.env.COURTLISTENER_TOKEN}`;
  }
  return headers;
}

const sleep = (ms: any) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch one page, retrying on 429 (rate limit) and transient 5xx. Honours the
 * server's Retry-After header when present, otherwise backs off exponentially.
 */
async function fetchPage(url: any, headers: any, attempt = 0) {
  const res = await fetch(url, { headers });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) {
      throw new Error(`CourtListener ${res.status} after ${attempt} retries for ${url}`);
    }
    const retryAfter = parseInt(res.headers.get('retry-after') || '', 10);
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(60000, 2000 * 2 ** attempt);
    process.stdout.write(`\n  ${res.status} — waiting ${Math.round(waitMs / 1000)}s then retrying …\n`);
    await sleep(waitMs);
    return fetchPage(url, headers, attempt + 1);
  }
  if (!res.ok) {
    throw new Error(`CourtListener ${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

/** Upsert one court row; returns true if it was a fresh insert. */
async function upsertCourt(client: any, c: any) {
  const { jurisdiction, court_type } = mapJurisdiction(c.jurisdiction);
  const fullName = c.full_name || c.short_name;
  if (!fullName) return null; // skip rows with no usable name
  const { rows } = await client.query(
    `insert into court_catalog
       (source, source_id, full_name, short_name, citation_abbrev, jurisdiction, court_type, url, in_use)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (source, source_id) do update
       set full_name = excluded.full_name,
           short_name = excluded.short_name,
           citation_abbrev = excluded.citation_abbrev,
           jurisdiction = excluded.jurisdiction,
           court_type = excluded.court_type,
           url = excluded.url,
           in_use = excluded.in_use
     returning (xmax = 0) as is_insert`,
    [
      SOURCE,
      c.id,
      fullName,
      c.short_name || null,
      c.citation_string || null,
      jurisdiction,
      court_type,
      c.url || null,
      c.in_use !== false,
    ]
  );
  return rows[0].is_insert;
}

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL: set DB_TARGET and DATABASE_URL_<TARGET>, or DATABASE_URL (backend/.env).');
    process.exit(1);
  }
  if (typeof fetch !== 'function') {
    console.error('global fetch is unavailable — run on Node 18+.');
    process.exit(1);
  }

  const headers = buildHeaders();
  if (!headers.Authorization) {
    console.warn('No COURTLISTENER_TOKEN set — using the anonymous rate limit. '
      + 'This may take a while with pauses for rate limiting. A free token '
      + '(courtlistener.com → Profile → API tokens) is much faster.');
  }

  const client = new Client({
    connectionString,
    ssl: needsSsl(connectionString) ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  console.log('Connected. Importing courts from CourtListener (writing as it goes) …');

  let inserted = 0;
  let updated = 0;
  let seen = 0;
  try {
    // Each page is written before fetching the next, so the on-conflict upsert
    // makes a re-run resume cheaply if the import is interrupted.
    let url = `${API_BASE}?page_size=100`;
    while (url) {
      const data = await fetchPage(url, headers);
      for (const c of (data.results || [])) {
        seen++;
        const isInsert = await upsertCourt(client, c);
        if (isInsert === true) inserted++; else if (isInsert === false) updated++;
      }
      url = data.next || null;
      process.stdout.write(`\r  processed ${seen} courts (${inserted} new, ${updated} updated) …`);
      if (url) await sleep(250); // be polite between pages
    }
    process.stdout.write('\n');
    console.log(`Done. ${inserted} inserted, ${updated} updated.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('\nCOURTS IMPORT FAILED:', err.message);
  console.error('Re-run the command to resume — already-imported courts are skipped.');
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
