/**
 * The 512 MiB budget the signing pipeline is sized for.
 *
 * This pins the memory `cloudbuild.yaml` gives the API container and the
 * per-read and per-stream limits the PDF engine works within, so configuration
 * drift cannot silently outgrow the container. The number of heavy operations
 * allowed at once is pinned, by behaviour, in `signingJobs.test.ts`.
 */
import fs from 'fs';
import path from 'path';

describe('signing container memory & concurrency budget configuration', () => {
  it('enforces Cloud Run memory strictly at 512Mi in cloudbuild.yaml', () => {
    const cloudbuildPath = path.join(__dirname, '..', '..', 'cloudbuild.yaml');
    const content = fs.readFileSync(cloudbuildPath, 'utf8');

    // Cloud Run api deploy step must specify --memory=512Mi
    expect(content).toMatch(/--memory=512Mi/);

    // Ensure no unauthorized memory growth is present in the main API deployment step
    const lines = content.split('\n');
    const apiDeployStartIndex = lines.findIndex((l) => l.includes("'${_SERVICE_NAME}'"));
    expect(apiDeployStartIndex).toBeGreaterThanOrEqual(0);

    const apiDeploySection = lines.slice(apiDeployStartIndex, apiDeployStartIndex + 35).join('\n');
    expect(apiDeploySection).toContain('--memory=512Mi');
    expect(apiDeploySection).not.toContain('--memory=1Gi');
    expect(apiDeploySection).not.toContain('--memory=2Gi');
  });

  it('maintains a bounded GCS read window and decompression limit', () => {
    const { MAX_READ_BYTES } = require('../../src/modules/signatures/pdf/gcsSource');
    const { MAX_DECODED_BYTES, MAX_ENCODED_BYTES } = require('../../src/modules/signatures/pdf/filters');
    const { MAX_XREF_BYTES } = require('../../src/modules/signatures/pdf/reader');

    // GCS read chunk must be bounded (default 8 MiB)
    expect(MAX_READ_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);

    // Stream inflation bounds
    expect(MAX_ENCODED_BYTES).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(MAX_DECODED_BYTES).toBeLessThanOrEqual(64 * 1024 * 1024);

    // Index working memory budget must be at or below 48 MiB
    expect(MAX_XREF_BYTES).toBeLessThanOrEqual(48 * 1024 * 1024);
  });
});
