import fs from 'fs';
import path from 'path';

/**
 * What `stress:setup` created, so `stress:run` knows who to log in as and
 * `stress:teardown` knows what to delete. Gitignored: it names real accounts.
 */
export interface StressState {
  runId: string;
  dbTarget: string;
  lawFirmId: string;
  users: { uid: string; email: string }[];
}

export const STATE_PATH = path.join(__dirname, '.state.json');

export function readState(): StressState {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error('No stress-test accounts found. Run `npm run stress:setup` first.');
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
}

export function writeState(state: StressState): void {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * The users exist in exactly one database. Pointing a run at the other API
 * would answer every call with 403 and report it as the server falling over.
 */
export function assertStateMatchesTarget(state: StressState, target: string): void {
  const targetIsLocal = ['localhost', '127.0.0.1'].includes(new URL(target).hostname);
  const stateIsLocal = state.dbTarget === 'local';
  if (targetIsLocal !== stateIsLocal) {
    throw new Error(
      `These accounts were created against the ${state.dbTarget} database but the target is ${target}. ` +
      'Run stress:teardown and stress:setup with the matching DB_TARGET.',
    );
  }
}
