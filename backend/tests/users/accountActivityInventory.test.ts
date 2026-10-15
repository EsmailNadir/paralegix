/**
 * `usersRepository.findAccountActivity` against real data.
 *
 * This function is the last guard before the unverified-account sweep hard-
 * deletes a `users` row: `db/check-user-delete-guards.ts` statically asserts
 * every cascading/set-null foreign key to `users(id)` is PROBED somewhere in
 * this function's source, but a static grep only proves the probe exists, not
 * that it actually finds the row it is supposed to find. `tests/users/
 * unverifiedAccounts.test.ts` covers the sweep's decision logic with
 * `findAccountActivity` entirely mocked (`mockResolvedValue(null)` or a name),
 * so nothing in the suite has ever run the real Drizzle query in this function
 * against a real row of each protected type. A probe that silently stopped
 * matching (a renamed column, a query built against the wrong table, a typo'd
 * `eq()`) would still pass every existing test and would make the sweep
 * hard-delete an in-use account.
 *
 * One case per probe in `findAccountActivity`'s list, seeding the ONE row that
 * probe exists to catch and nothing else, plus a control account with zero
 * activity. RED IF: any probe stops matching real data for its own reference
 * type, or the control starts reporting activity it does not have.
 */
import { randomUUID } from 'crypto';

import {
  testPool,
  createFirm,
  createFirmMember,
  createPersonClient,
} from '../support/setupInProcess';

// eslint-disable-next-line global-require -- CommonJS repository module.
const usersRepository = require('../../src/modules/users/users.repository');

async function createBareUser(name = 'Fixture user'): Promise<string> {
  const uid = `uid-${randomUUID().slice(0, 8)}`;
  await testPool.query(
    `insert into users (id, email, name, user_type) values ($1, $2, $3, 'firm_member')`,
    [uid, `${uid}@example.test`, name],
  );
  return uid;
}

async function createMatter(lawFirmId: string, overrides: { createdBy?: string; leadUserId?: string } = {}): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into matters (id, law_firm_id, name, matter_reference_id, created_by, lead_user_id)
     values ($1, $2, 'Fixture matter', $3, $4, $5)`,
    [id, lawFirmId, `REF-${id.slice(0, 8)}`, overrides.createdBy ?? null, overrides.leadUserId ?? null],
  );
  return id;
}

async function createTask(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into tasks (id, law_firm_id, title) values ($1, $2, 'Fixture task')`,
    [id, lawFirmId],
  );
  return id;
}

async function createGroupConversation(lawFirmId: string): Promise<string> {
  const id = randomUUID();
  await testPool.query(
    `insert into conversations (id, law_firm_id, conversation_type, title) values ($1, $2, 'group', 'Fixture group')`,
    [id, lawFirmId],
  );
  return id;
}

interface Case {
  /** The exact string `findAccountActivity` must return once the row exists. */
  probe: string;
  /** Seeds ONLY the row that probe is meant to catch. */
  seed: (lawFirmId: string, userId: string) => Promise<void>;
}

const CASES: Case[] = [
  {
    probe: 'members',
    seed: async (lawFirmId, userId) => {
      await createFirmMember(lawFirmId, { uid: userId });
    },
  },
  {
    probe: 'matterMembers',
    seed: async (lawFirmId, userId) => {
      const matterId = await createMatter(lawFirmId);
      await testPool.query(
        `insert into matter_members (matter_id, user_id, law_firm_id, role, joined_at)
         values ($1, $2, $3, 'member', now())`,
        [matterId, userId, lawFirmId],
      );
    },
  },
  {
    probe: 'matterCreated',
    seed: async (lawFirmId, userId) => {
      await createMatter(lawFirmId, { createdBy: userId });
    },
  },
  {
    probe: 'matterLead',
    seed: async (lawFirmId, userId) => {
      await createMatter(lawFirmId, { leadUserId: userId });
    },
  },
  {
    probe: 'clients',
    seed: async (lawFirmId, userId) => {
      await createPersonClient(lawFirmId, { userId });
    },
  },
  {
    probe: 'fileClientAccess',
    seed: async (lawFirmId, userId) => {
      // The access record points at a real document: `file_id` is a foreign key
      // into the tree, so a made-up path is no longer a thing it can hold.
      const filesRepo = require('../../src/modules/files/files.repository');
      const root = await filesRepo.ensureScopeRoot(lawFirmId, { scope: 'firm' });
      const file = await filesRepo.createFile(lawFirmId, {
        parentId: root, name: 'doc.pdf', mimeType: 'application/pdf',
      });
      await testPool.query(
        `insert into file_client_access (law_firm_id, client_user_id, file_id)
         values ($1, $2, $3)`,
        [lawFirmId, userId, file.id],
      );
    },
  },

  {
    probe: 'taskAssignees',
    seed: async (lawFirmId, userId) => {
      const taskId = await createTask(lawFirmId);
      await testPool.query(`insert into task_assignees (law_firm_id, task_id, user_id)
         select t.law_firm_id, t.id, $2 from tasks t where t.id = $1`, [taskId, userId]);
    },
  },
  {
    probe: 'taskSubtasks',
    seed: async (lawFirmId, userId) => {
      const taskId = await createTask(lawFirmId);
      await testPool.query(
        `insert into task_subtasks (law_firm_id, task_id, title, assignee_user_id)
         values ($1, $2, 'Fixture subtask', $3)`,
        [lawFirmId, taskId, userId],
      );
    },
  },
  {
    probe: 'eventAssignees',
    seed: async (lawFirmId, userId) => {
      const matterId = await createMatter(lawFirmId);
      const eventId = randomUUID();
      await testPool.query(
        `insert into events (id, law_firm_id, matter_id, title) values ($1, $2, $3, 'Fixture hearing')`,
        [eventId, lawFirmId, matterId],
      );
      await testPool.query(
        `insert into event_assignees (law_firm_id, event_id, user_id) values ($1, $2, $3)`,
        [lawFirmId, eventId, userId],
      );
    },
  },
  {
    probe: 'conversationParticipants',
    seed: async (lawFirmId, userId) => {
      const conversationId = await createGroupConversation(lawFirmId);
      await testPool.query(
        `insert into conversation_participants (conversation_id, law_firm_id, participant_user_id, participant_type)
         values ($1, $2, $3, 'firm_member')`,
        [conversationId, lawFirmId, userId],
      );
    },
  },
  {
    probe: 'conversations',
    seed: async (lawFirmId, userId) => {
      // The legacy direct 1:1 shape: the portal client's uid lives right on the
      // conversation row's `client_id`, not through a participant join.
      await testPool.query(
        `insert into conversations (id, law_firm_id, conversation_type, client_id)
         values ($1, $2, 'direct', $3)`,
        [randomUUID(), lawFirmId, userId],
      );
    },
  },
  {
    probe: 'userOauthTokens',
    seed: async (_lawFirmId, userId) => {
      await testPool.query(
        `insert into user_oauth_tokens (user_id, provider, access_token) values ($1, 'google', 'fixture-token')`,
        [userId],
      );
    },
  },
  {
    probe: 'oauthStates',
    seed: async (_lawFirmId, userId) => {
      await testPool.query(
        `insert into oauth_states (state, user_id, provider) values ($1, $2, 'google')`,
        [`state-${randomUUID()}`, userId],
      );
    },
  },
  {
    probe: 'notifications',
    seed: async (lawFirmId, userId) => {
      await testPool.query(
        `insert into notifications (id, law_firm_id, user_id, type, title, body)
         values ($1, $2, $3, 'fixture', 'Fixture', 'Body')`,
        [randomUUID(), lawFirmId, userId],
      );
    },
  },
  {
    probe: 'digestSends',
    seed: async (lawFirmId, userId) => {
      await testPool.query(
        `insert into digest_sends (law_firm_id, user_id, sent_on) values ($1, $2, current_date)`,
        [lawFirmId, userId],
      );
    },
  },
];

describe('findAccountActivity against real data', () => {
  it('reports no activity for a brand-new account with zero references', async () => {
    const userId = await createBareUser();
    expect(await usersRepository.findAccountActivity(userId)).toBeNull();
  });

  it.each(CASES.map((c) => [c.probe, c] as const))(
    'catches a %s reference',
    async (_name, testCase) => {
      const firm = await createFirm();
      const userId = await createBareUser();

      // Control: this specific user has nothing yet.
      expect(await usersRepository.findAccountActivity(userId)).toBeNull();

      await testCase.seed(firm.id, userId);

      expect(await usersRepository.findAccountActivity(userId)).toBe(testCase.probe);
    },
  );

  it('covers every probe findAccountActivity actually runs, so a new one added there cannot go untested here', () => {
    // eslint-disable-next-line global-require
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/modules/users/users.repository.ts'),
      'utf8',
    );
    const start = source.indexOf('async findAccountActivity');
    const end = source.indexOf('Hard-delete a users row');
    const body = source.slice(start, end);
    const probeNames = Array.from(body.matchAll(/^\s*\[(?:'|")(\w+)(?:'|")/gm)).map((m: any) => m[1]);

    expect(probeNames.length).toBeGreaterThan(0);
    expect(new Set(CASES.map((c) => c.probe))).toEqual(new Set(probeNames));
  });
});
