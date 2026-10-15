/**
 * Creates the stress-test firm and its users: one owner plus Attorney members,
 * all pre-verified Firebase identities on the reserved .test TLD so nothing can
 * ever be emailed to them. The firm is comped with no plan limits.
 *
 * Usage, from backend/:  DB_TARGET=staging npm run stress:setup -- --users 10
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { STATE_PATH, writeState, type StressState } from './state';

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

async function main() {
  const dbTarget = String(process.env.DB_TARGET || '').toLowerCase();
  if (dbTarget !== 'staging' && dbTarget !== 'local') {
    throw new Error('Set DB_TARGET=staging (or local). The stress test never creates accounts anywhere else.');
  }
  if (fs.existsSync(STATE_PATH) && !process.argv.includes('--force')) {
    throw new Error('Stress-test accounts already exist. Run `npm run stress:teardown` first, or pass --force.');
  }
  const i = process.argv.indexOf('--users');
  const users = i >= 0 ? Number(process.argv[i + 1]) : 10;
  if (!Number.isInteger(users) || users < 1 || users > 50) throw new Error('--users must be an integer from 1 to 50.');

  // Required after the guard: importing db.ts opens the pool against DB_TARGET.
  const { pool } = require('../../src/shared/database/db');
  const adminService = require('../../src/modules/admin/admin.service');
  const adminRepo = require('../../src/modules/admin/admin.repository');

  const runId = Date.now().toString(36);
  const email = (n: number) => `stress-${runId}-${n}@stress.paralegix.test`;
  // Nobody signs in with this; the run mints tokens. It only has to satisfy the account rules.
  const password = randomBytes(18).toString('base64url');

  try {
    console.log(`Creating ${users} users in "Stress Test Firm ${runId}" (DB_TARGET=${dbTarget})`);
    const owner = await adminService.adminCreateAccount({
      kind: 'firm_owner', email: email(1), password, name: 'Stress User 1', firmName: `Stress Test Firm ${runId}`,
    });
    const state: StressState = { runId, dbTarget, lawFirmId: owner.account.lawFirmId, users: [{ uid: owner.account.uid, email: email(1) }] };
    writeState(state);

    const roles = await adminRepo.listLawFirmRoles(state.lawFirmId);
    const attorney = roles.find((r: any) => r.name === 'Attorney');
    if (!attorney) throw new Error('The new firm has no built-in Attorney role.');

    for (let n = 2; n <= users; n += 1) {
      const member = await adminService.adminCreateAccount({
        kind: 'member', email: email(n), password, name: `Stress User ${n}`, lawFirmId: state.lawFirmId, roleId: attorney.id,
      });
      state.users.push({ uid: member.account.uid, email: email(n) });
      // Written after every user so a failure part-way still leaves teardown a full list.
      writeState(state);
    }
    console.log(`Done. lawFirmId=${state.lawFirmId}. State written to ${STATE_PATH}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\nSTRESS SETUP FAILED: ${err.message}`);
  process.exit(1);
});
