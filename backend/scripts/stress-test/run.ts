/**
 * Runs the stress test against the users `stress:setup` created.
 *
 * Usage, from backend/:
 *   npm run stress:run                                    10 users, realistic, 5 min, staging
 *   npm run stress:run -- --profile docs-burst --rounds 3
 *   npm run stress:run -- --target http://localhost:5001 --users 1 --duration 30
 */
import path from 'path';
import { customTokenSource } from './auth';
import { ApiClient } from './client';
import { parseArgs } from './config';
import { sampleDocx, samplePdf } from './fixtures';
import { runDocsBurst, runRealistic } from './profiles';
import { buildReport, writeReport } from './report';
import { assertStateMatchesTarget, readState } from './state';
import type { Sample } from './stats';
import type { Vu } from './vu';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const state = readState();
  assertStateMatchesTarget(state, config.target);
  const apiKey = process.env.TEST_FIREBASE_API_KEY;
  if (!apiKey) throw new Error('TEST_FIREBASE_API_KEY must be set in backend/.env (the Firebase web API key).');

  const { auth } = require('../../src/shared/database/firebase');
  const mint = (uid: string): Promise<string> => auth.createCustomToken(uid);

  const users = state.users.slice(0, config.users);
  if (users.length < config.users) console.warn(`Only ${users.length} users exist; running with ${users.length}.`);

  const samples: Sample[] = [];
  const failures: string[] = [];
  const vus: Vu[] = users.map((user, i) => ({
    index: i + 1,
    uid: user.uid,
    lawFirmId: state.lawFirmId,
    api: new ApiClient(config.target, customTokenSource(user.uid, apiKey, mint), samples),
    state: { matterId: null, docxTemplateId: null, htmlTemplateId: null },
  }));

  // The first request after an idle period includes any Cloud Run cold start.
  await vus[0].api.call('health.first', 'GET', '/api/health', undefined, { auth: false });
  console.log(`Signing in ${vus.length} users...`);
  await Promise.all(vus.map((vu) => vu.api.call('core.profile', 'GET', '/api/users/profile')));

  console.log(`Running ${config.profile} against ${config.target}...`);
  const fixtures = { pdf: samplePdf(), docx: sampleDocx() };
  const started = Date.now();
  if (config.profile === 'realistic') await runRealistic(vus, config, fixtures, failures);
  else await runDocsBurst(vus, config, fixtures, failures);

  const markdown = buildReport(config, vus.length, samples, failures, Date.now() - started);
  console.log(`\n${markdown}`);
  console.log(`Report written to ${writeReport(config, markdown, samples)}`);
}

main().catch((err) => {
  console.error(`\nSTRESS RUN FAILED: ${err.message}`);
  process.exit(1);
});
