/**
 * Configure CORS on a GCS bucket so the browser can talk to it directly.
 *
 *   npx tsx backend/scripts/set-gcs-cors.ts --target staging
 *   npx tsx backend/scripts/set-gcs-cors.ts --target prod
 *   npx tsx backend/scripts/set-gcs-cors.ts --target staging --print
 *
 * Two flows depend on this, and both break in ways that look like application
 * bugs when the config drifts:
 *
 *   1. Direct-to-GCS uploads. The browser PUTs bytes to the resumable session
 *      URL that `/upload-init` mints (files.upload.routes.ts). A chunked upload
 *      also has to READ the `Range` header off the 308 response to learn how
 *      many bytes GCS persisted, which is the only way an interrupted upload can
 *      resume. A browser cannot see a response header the bucket does not name
 *      in `responseHeader`, so omitting `Range` does not fail loudly: the upload
 *      simply can never resume.
 *   2. Ranged reads. Viewers that fetch page ranges rather than whole files need
 *      `Accept-Ranges` and `Content-Range` exposed for the same reason.
 *
 * `--target` picks the bucket AND its origins together, because the two are not
 * independent: applying the staging origin list to the production bucket locks
 * the real frontend out of every upload. The pairs live in TARGETS below rather
 * than in an env var so that a missing variable cannot silently narrow a bucket
 * to localhost.
 *
 * Re-running is safe. `setCorsConfiguration` overwrites wholesale, so the
 * config in this file is the whole truth for the bucket, not a patch onto it.
 */

const path = require('path');

/**
 * Response headers the browser is allowed to read back.
 *
 * `Range` is the load-bearing one: GCS answers every incomplete chunk of a
 * resumable upload with `308` plus a `Range` header giving the persisted byte
 * count, and resuming means reading it. `Accept-Ranges` and `Content-Range`
 * serve ranged reads. `Content-Disposition` is what gives a download its real
 * filename. `ETag` and `Location` complete the resumable protocol.
 *
 * `Content-Type` and `Content-Length` are CORS-safelisted and readable without
 * being listed; they are kept here because the bucket has always carried them
 * and dropping them would be an unrelated change.
 */
export const RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Content-Range',
  'Accept-Ranges',
  'Range',
  'x-goog-resumable',
  'ETag',
  'Location',
];

/** Methods the browser issues: reads, preflight, and the upload PUTs. */
export const METHODS = ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST'];

/**
 * Bucket and origins per environment, mirroring what each bucket carries today.
 *
 * The localhost origins are on the production bucket deliberately: `GCS_BUCKET`
 * in a local `.env` points at `lawfirms`, so local development reads and writes
 * production objects. That is worth revisiting, but it is a storage decision
 * rather than a CORS one, and narrowing the list here would break local dev
 * without fixing it.
 */
export const TARGETS: Record<string, { bucket: string; origins: string[] }> = {
  staging: {
    bucket: 'lawfirms-staging',
    origins: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'https://staging.paralegix.com',
    ],
  },
  prod: {
    bucket: 'lawfirms',
    origins: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'https://paralegix.com',
      'https://www.paralegix.com',
    ],
  },
};

/** The exact configuration applied to one target's bucket. */
export function corsConfigFor(target: string) {
  const entry = TARGETS[target];
  if (!entry) {
    throw new Error(`Unknown target "${target}". Use one of: ${Object.keys(TARGETS).join(', ')}`);
  }
  return {
    bucket: entry.bucket,
    cors: [
      {
        origin: entry.origins,
        method: METHODS,
        responseHeader: RESPONSE_HEADERS,
        maxAgeSeconds: 3600,
      },
    ],
  };
}

function readTarget() {
  const index = process.argv.indexOf('--target');
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value) {
    throw new Error(`--target is required. Use one of: ${Object.keys(TARGETS).join(', ')}`);
  }
  return value;
}

async function main() {
  const target = readTarget();
  const { bucket: bucketName, cors } = corsConfigFor(target);

  // Required inside main, not at module scope: the config above is imported by
  // tests, and a top-level require here would boot Firebase to read a constant.
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const { admin } = require('../src/shared/database/firebase');
  const bucket = admin.storage().bucket(bucketName);

  if (process.argv.includes('--print')) {
    const [metadata] = await bucket.getMetadata();
    console.log(`Current CORS on gs://${bucketName}:`);
    console.log(JSON.stringify(metadata.cors || [], null, 2));
    return;
  }

  await bucket.setCorsConfiguration(cors);
  console.log(`CORS applied to gs://${bucketName} (${target}) for origins:`);
  cors[0].origin.forEach((o: string) => console.log(`  - ${o}`));
  console.log('Exposed response headers:');
  cors[0].responseHeader.forEach((h: string) => console.log(`  - ${h}`));
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Failed to set CORS:', err.message || err);
      process.exit(1);
    });
}
