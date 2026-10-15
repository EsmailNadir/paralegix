/**
 * The role label the members and roles settings pages print beside a person.
 *
 * Precedence is the point: ownership beats everything, a custom role assigned
 * by id beats the derived `role` string, and a member with nothing resolvable
 * reads as Staff rather than blank. A wrong label here is how a firm admin
 * misjudges who can see trust or billing, so each rung is pinned.
 */
import { resolveMemberRoleName, roleDisplayLabel } from '@/lib/utils/resolveMemberRoleName';
import type { Member } from '@/types/member';
import type { Role } from '@/types/role';

function member(overrides: Partial<Member>): Member {
  return { userId: 'u-1', name: 'Pat', ...overrides };
}

const ROLES = new Map<string, Role>([
  ['role-sr', { id: 'role-sr', name: 'Senior Associate', permissions: [] }],
]);

describe('resolveMemberRoleName', () => {
  it('labels the owner Owner even when a custom role is also assigned', () => {
    expect(resolveMemberRoleName(member({ isOwner: true, roleId: 'role-sr', role: 'staff' }), ROLES)).toBe('Owner');
  });

  it('uses the assigned custom role name over the derived role string', () => {
    expect(resolveMemberRoleName(member({ roleId: 'role-sr', role: 'staff' }), ROLES)).toBe('Senior Associate');
  });

  it('falls back to the role string when the roleId is not in the firm roles', () => {
    // A role deleted, or not loaded yet: show what the endpoint derived.
    expect(resolveMemberRoleName(member({ roleId: 'role-gone', role: 'paralegal' }), ROLES)).toBe('Paralegal');
  });

  it('reads Staff when nothing is resolvable', () => {
    expect(resolveMemberRoleName(member({}), ROLES)).toBe('Staff');
    expect(resolveMemberRoleName(member({ role: '   ' }), ROLES)).toBe('Staff');
    expect(resolveMemberRoleName(member({ role: null, roleId: null }), new Map())).toBe('Staff');
  });
});

describe('roleDisplayLabel', () => {
  it.each([
    ['owner', 'Owner'],
    ['ADMIN', 'Admin'],
    ['  Attorney ', 'Attorney'],
    ['para_legal', 'Paralegal'],
    ['para-legal', 'Paralegal'],
    ['Para Legal', 'Paralegal'],
    ['staff', 'Staff'],
    ['member', 'Staff'],
  ])('maps the built-in value %p to %p', (value, label) => {
    expect(roleDisplayLabel(value)).toBe(label);
  });

  it('capitalises only the first letter of an unknown role and lowercases the rest', () => {
    expect(roleDisplayLabel('  BOOKKEEPER  ')).toBe('Bookkeeper');
    expect(roleDisplayLabel('office manager')).toBe('Office manager');
  });

  it('does not collapse a custom role that merely contains a built-in word', () => {
    expect(roleDisplayLabel('Admin Assistant')).toBe('Admin assistant');
  });

  it('returns null for empty, whitespace, null and undefined', () => {
    expect(roleDisplayLabel('')).toBeNull();
    expect(roleDisplayLabel('   ')).toBeNull();
    expect(roleDisplayLabel(null)).toBeNull();
    expect(roleDisplayLabel(undefined)).toBeNull();
  });
});
