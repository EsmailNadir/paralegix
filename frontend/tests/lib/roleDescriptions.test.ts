/**
 * The role picker's one-line summaries are hand-written, so they drift from the
 * permission sets they describe. These pin the claim that matters most: a
 * description may mention billing or trust only for a role that holds a permission
 * in that area.
 *
 * What has to break for these to go red: a description promising billing or trust
 * access to a built-in role whose permissions include none of it (Staff did, after
 * the financial reads left the member baseline).
 */
import { BUILT_IN_ROLES } from '@/lib/constants/permissions';
import { BUILT_IN_ROLE_DESCRIPTIONS, describeRole } from '@/lib/constants/roleDescriptions';

const holds = (key: keyof typeof BUILT_IN_ROLES, prefix: string) =>
  BUILT_IN_ROLES[key].permissions.some((code) => code.startsWith(prefix));

describe('built-in role descriptions', () => {
  it('describes every built-in role', () => {
    for (const role of Object.values(BUILT_IN_ROLES)) {
      expect(BUILT_IN_ROLE_DESCRIPTIONS[role.name]).toBeTruthy();
    }
  });

  it.each(Object.values(BUILT_IN_ROLES).map((role) => [role.name, role.key] as const))(
    'does not promise %s billing or trust access it does not hold',
    (name, key) => {
      const description = BUILT_IN_ROLE_DESCRIPTIONS[name];
      if (/billing/i.test(description)) expect(holds(key, 'billing.')).toBe(true);
      if (/trust/i.test(description)) expect(holds(key, 'trust.')).toBe(true);
    },
  );

  it('leaves billing and trust out of the Staff description, since Staff holds neither', () => {
    expect(holds('staff', 'billing.')).toBe(false);
    expect(holds('staff', 'trust.')).toBe(false);
    expect(describeRole({ name: 'Staff' })).not.toMatch(/billing|trust/i);
  });
});
