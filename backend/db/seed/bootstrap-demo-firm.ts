/**
 * Create the demo law firm and its three accounts on an EMPTY database, so that
 * seed-local-testdata.ts has a firm and an owner to attach its demo data to.
 *
 *   DB_TARGET=local   npx tsx backend/db/seed/bootstrap-demo-firm.ts
 *   DB_TARGET=staging npx tsx backend/db/seed/bootstrap-demo-firm.ts --allow-remote
 *
 * The three accounts already exist in Firebase Auth. This script only creates
 * the Postgres rows that Firebase knows nothing about: `users`, `law_firms`,
 * `roles`, and `members`.
 *
 *   test1@gmail.com   firm_member, firm Owner
 *   test2@gmail.com   firm_member, Attorney
 *   client1@gmail.com client, portal user (its `clients` row is written by
 *                     seed-local-testdata.ts --portal-user, not here)
 *
 * The firm itself is created through the real `createLawFirm` service rather
 * than by hand, so it gets exactly what a firm created through signup gets:
 * five built-in roles, the owner membership, ten default practice areas, ten
 * default charge codes, the default lead pipeline, and the default intake form.
 *
 * Idempotent. It reuses the demo firm when one already exists for the owner,
 * and upserts every user and member row, so re-running changes nothing.
 *
 * Writing to a hosted Supabase database requires --allow-remote, which is the
 * only way to seed staging. Loads env from backend/.env.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const { resolveDbUrl } = require('../../src/shared/database/resolveDbUrl');

const ALLOW_REMOTE = process.argv.includes('--allow-remote');

const argOf = (flag: any, fallback: any) => {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const FIRM_NAME = argOf('--firm-name', 'Paralegix Demo Firm');

// The Firebase uids these emails already resolve to. They are hard-coded rather
// than looked up so the script needs no Firebase credentials, and so the same
// uid lands in both the local and the staging database. Both environments
// authenticate against the same Firebase project.
const OWNER_UID = 'wZqzka3PPBQAOhXW6rCVlohJNW32';
const ATTORNEY_UID = 'GiATlJgEfeSZak86AZLqNv0DPqH3';
const PORTAL_CLIENT_UID = 'BGJON7u3DOhmH07sCpQMZX57iO02';

const DEMO_USERS = [
  { uid: OWNER_UID, email: 'test1@gmail.com', name: 'Alice Attorney', userType: 'firm_member' },
  { uid: ATTORNEY_UID, email: 'test2@gmail.com', name: 'Bob Barrister', userType: 'firm_member' },
  { uid: PORTAL_CLIENT_UID, email: 'client1@gmail.com', name: 'Marcus Whitfield', userType: 'client' },
];

async function main() {
  const connectionString = resolveDbUrl();
  if (!connectionString) {
    console.error('No database URL resolved (DB_TARGET / DATABASE_URL in backend/.env).');
    process.exit(1);
  }
  const isRemote = /supabase|pooler\.supabase\.com/i.test(connectionString);
  if (isRemote && !ALLOW_REMOTE) {
    console.error('Refusing to run: this resolves to a hosted Supabase database.');
    console.error('Set DB_TARGET=local, or pass --allow-remote to seed staging on purpose.');
    process.exit(1);
  }
  if (String(process.env.DB_TARGET).toLowerCase() === 'prod') {
    console.error('Refusing to run against DB_TARGET=prod. This script is for local and staging only.');
    process.exit(1);
  }

  // Required after the guard above, because importing db.ts opens the pool
  // against whatever DB_TARGET resolved to.
  const { pool } = require('../../src/shared/database/db');
  const lawfirmsService = require('../../src/modules/lawfirms/lawfirms.service');
  const membersRepo = require('../../src/modules/lawfirms/members/members.repository');

  console.log(`Target: ${isRemote ? 'REMOTE (Supabase)' : 'local'}  DB_TARGET=${process.env.DB_TARGET || '(unset)'}\n`);

  try {
    // Users. The columns match what auth.service.ts writes when a real account
    // finishes registration, plus the consent stamps that a signup collects, so
    // these accounts are not held at a consent prompt.
    for (const u of DEMO_USERS) {
      await pool.query(
        `insert into users (id, email, name, user_type, timezone, terms_accepted_at, privacy_accepted_at, consent_version)
         values ($1,$2,$3,$4,'America/New_York',now(),now(),'demo-seed')
         on conflict (id) do update
            set email = excluded.email,
                name = excluded.name,
                user_type = excluded.user_type,
                timezone = coalesce(users.timezone, excluded.timezone),
                terms_accepted_at = coalesce(users.terms_accepted_at, excluded.terms_accepted_at),
                privacy_accepted_at = coalesce(users.privacy_accepted_at, excluded.privacy_accepted_at),
                deleted_at = null,
                updated_at = now()`,
        [u.uid, u.email, u.name, u.userType]
      );
      console.log(`  user  ${u.email.padEnd(20)} ${u.userType.padEnd(12)} ${u.uid}`);
    }

    // Firm. Reuse the one this owner already owns under this name, so a re-run
    // does not stack a second demo firm on the same account.
    const { rows: existing } = await pool.query(
      `select f.id
         from law_firms f
         join members m on m.law_firm_id = f.id
        where m.user_id = $1 and m.is_owner and f.name = $2
        limit 1`,
      [OWNER_UID, FIRM_NAME]
    );

    let lawFirmId: string;
    if (existing.length) {
      lawFirmId = existing[0].id;
      console.log(`\n  firm  reused "${FIRM_NAME}" ${lawFirmId}`);
    } else {
      ({ lawFirmId } = await lawfirmsService.createLawFirm({
        name: FIRM_NAME,
        userId: OWNER_UID,
        firmSize: '2-10',
        practiceArea: 'General Practice',
      }));
      console.log(`\n  firm  created "${FIRM_NAME}" ${lawFirmId}`);
    }

    // Second firm member, so member pickers, assignment and timekeeper lists
    // have more than one name in them.
    const { rows: attorneyRole } = await pool.query(
      `select id from roles where law_firm_id = $1 and name = 'Attorney' limit 1`,
      [lawFirmId]
    );
    if (attorneyRole.length) {
      await membersRepo.addMember(lawFirmId, ATTORNEY_UID, {
        roleId: attorneyRole[0].id,
        isOwner: false,
        joinedAt: new Date(),
        defaultHourlyRateCents: 30000,
      });
      console.log(`  member test2@gmail.com joined as Attorney`);
    } else {
      console.warn('  WARNING no Attorney role found; test2@gmail.com was not added.');
    }

    // Lift the starter-tier caps. The starter plan limits matters to 25 and
    // gates off trust accounting, templates, analytics, calendar sync and
    // e-signature, none of which the demo data could otherwise exercise.
    await pool.query(
      `update law_firms
          set plan_id = 'enterprise',
              billing_status = 'comped',
              plan = coalesce(plan, '{}'::jsonb)
                     || jsonb_build_object('planId','enterprise','comped',true,'unlimitedOverride',true)
        where id = $1`,
      [lawFirmId]
    );

    const { rows: counts } = await pool.query(
      `select 'roles' t, count(*) n from roles where law_firm_id = $1
       union all select 'members', count(*) from members where law_firm_id = $1
       union all select 'practice_areas', count(*) from practice_areas where law_firm_id = $1
       union all select 'billing_codes', count(*) from billing_codes where law_firm_id = $1
       union all select 'lead_stages', count(*) from lead_stages where law_firm_id = $1
       union all select 'intake_form_templates', count(*) from intake_form_templates where law_firm_id = $1
       order by 1`,
      [lawFirmId]
    );
    console.log('\nFirm now holds:');
    for (const r of counts) console.log(`  ${r.t.padEnd(24)} ${r.n}`);

    console.log('\nNext, seed the demo data into it:');
    console.log(`  npx tsx backend/db/seed/seed-local-testdata.ts \\`);
    console.log(`    --firm ${lawFirmId} --owner ${OWNER_UID} \\`);
    console.log(`    --portal-user ${PORTAL_CLIENT_UID} --portal-email client1@gmail.com${isRemote ? ' \\\n    --allow-remote' : ''}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error('\nBOOTSTRAP FAILED:', err.message);
  if (err.detail) console.error('  detail:', err.detail);
  process.exit(1);
});

// Marks this file a module rather than a script. Without it every
// top-level const here would share one global scope with the other
// tools and collide on names like `args` and `main`.
export {};
