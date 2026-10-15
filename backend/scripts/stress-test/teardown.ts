/**
 * Deletes the stress-test Firebase identities. The Firebase project is shared
 * across environments, so these must not linger. The firm and the rows it
 * created stay in the database: staging data is disposable, and the firm is
 * named "Stress Test Firm <runId>" so it is easy to recognise.
 *
 * Usage, from backend/:  npm run stress:teardown
 */
import fs from 'fs';
import path from 'path';
import { STATE_PATH, readState } from './state';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

async function main() {
  const state = readState();
  const { auth } = require('../../src/shared/database/firebase');
  for (const user of state.users) {
    await auth.deleteUser(user.uid).catch((err: any) => {
      if (err.code !== 'auth/user-not-found') throw err;
    });
  }
  fs.unlinkSync(STATE_PATH);
  console.log(`Deleted ${state.users.length} Firebase identities.`);
  console.log(`"Stress Test Firm ${state.runId}" (${state.lawFirmId}) stays in the ${state.dbTarget} database.`);
}

main().catch((err) => {
  console.error(`\nSTRESS TEARDOWN FAILED: ${err.message}`);
  process.exit(1);
});
