/**
 * Dev/test helper: create (or update) a Firebase Auth user with emailVerified=true
 * so the account passes both the client and server email-verification gates and
 * can be used for end-to-end manual/automated testing without receiving a real
 * verification email.
 *
 * Usage: npx tsx backend/scripts/make-verified-user.ts <email> <password> [displayName]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { auth } = require('../src/shared/database/firebase');

(async () => {
  const [, , email, password, ...nameParts] = process.argv;
  const displayName = nameParts.join(' ') || undefined;
  if (!email || !password) {
    console.error('Usage: npx tsx backend/scripts/make-verified-user.ts <email> <password> [displayName]');
    process.exit(1);
  }

  let user;
  try {
    user = await auth.getUserByEmail(email);
    user = await auth.updateUser(user.uid, { password, emailVerified: true, ...(displayName ? { displayName } : {}) });
    console.log(`UPDATED ${email} uid=${user.uid} emailVerified=${user.emailVerified}`);
  } catch (err: any) {
    if (err.code === 'auth/user-not-found') {
      user = await auth.createUser({ email, password, emailVerified: true, ...(displayName ? { displayName } : {}) });
      console.log(`CREATED ${email} uid=${user.uid} emailVerified=${user.emailVerified}`);
    } else {
      throw err;
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
