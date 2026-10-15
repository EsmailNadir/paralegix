/**
 * Which folders a document may be filed into - pure unit tests.
 *
 * `parseFilingPath` answers one question: is this prefix somewhere a firm member
 * can browse to? Two callers depend on the answer and they must not disagree.
 *
 * The signatures module files a completed document into a caller-supplied folder
 * and then mirrors it into the `files` table. Staying inside the firm prefix was
 * the whole check, which is not enough — the firm prefix also holds the preserved
 * archives, the scratch prefix an open session works in, and the per-conversation
 * attachment folders. Filed into `signatures/`, an executed document is invisible
 * and delete-protected; filed into `signing-work/{token}/`, the session's own
 * sweep deletes it seconds after completion. Both were reachable by naming the
 * path in the request.
 *
 * These hit no server and no bucket. Run alone with:
 *
 *   __TEST_TOKEN__=offline npx jest tests/files/filingPaths.test.js
 */

const { parseFilingPath, contextToPrefix, FILE_CONTEXT_TYPES } = require('../../src/modules/files/files.context');

const FIRM = '1354e5d3-1b94-46b2-b78d-0e04faece7d4';
const MATTER = 'a2a6d0f0-7b3a-4a2e-9c11-5f0f5a1b2c3d';
const TASK = 'b7c1e2d3-4f5a-6b7c-8d9e-0a1b2c3d4e5f';
const CLIENT = 'c9d8e7f6-5a4b-3c2d-1e0f-9a8b7c6d5e4f';

describe('the four filing locations', () => {
  test('resolves every prefix contextToPrefix produces', () => {
    // Derived from the same module as the prefix builder, so this asserts the two
    // directions agree rather than that they merely look alike.
    const cases = [
      [{ type: FILE_CONTEXT_TYPES.general, lawFirmId: FIRM }, { scope: 'firm' }],
      [{ type: FILE_CONTEXT_TYPES.matter, lawFirmId: FIRM, entityId: MATTER }, { scope: 'matter', matterId: MATTER }],
      [{ type: FILE_CONTEXT_TYPES.task, lawFirmId: FIRM, entityId: TASK }, { scope: 'task', taskId: TASK }],
      [{ type: FILE_CONTEXT_TYPES.client, lawFirmId: FIRM, entityId: CLIENT }, { scope: 'client', clientId: CLIENT }],
    ];
    for (const [context, expected] of cases) {
      expect(parseFilingPath(FIRM, contextToPrefix(context))).toEqual(expected);
    }
  });

  test('a sub-folder is still the folder it sits in', () => {
    // Users file into nested folders; only the segments naming the owning entity
    // decide the answer.
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/${MATTER}/Contracts/Signed/`))
      .toEqual({ scope: 'matter', matterId: MATTER });
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/general/Executed/2026/`))
      .toEqual({ scope: 'firm' });
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/clients/${CLIENT}/Engagement/`))
      .toEqual({ scope: 'client', clientId: CLIENT });
  });

  test('a trailing slash is optional and changes nothing', () => {
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/general`))
      .toEqual(parseFilingPath(FIRM, `lawfirmids/${FIRM}/general/`));
  });
});

describe('places a document may not be filed', () => {
  test('rejects the preserved-record archives', () => {
    // Filed here an executed document is invisible to every listing and refused
    // by delete, so its owner can neither find it nor remove it.
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/signatures/`)).toBeNull();
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/invoices/`)).toBeNull();
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/signatures/some-token/`)).toBeNull();
  });

  test("rejects the scratch prefix a session deletes when it finishes", () => {
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/signing-work/some-token/`)).toBeNull();
  });

  test('rejects conversation attachment folders', () => {
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/messaging/${FIRM}_uid/`)).toBeNull();
  });

  test('rejects another firm, and the bucket root', () => {
    const other = 'ffffffff-1111-2222-3333-444444444444';
    expect(parseFilingPath(FIRM, `lawfirmids/${other}/general/`)).toBeNull();
    expect(parseFilingPath(FIRM, 'signing-uploads/abc/doc.pdf')).toBeNull();
    expect(parseFilingPath(FIRM, `otherroot/${FIRM}/general/`)).toBeNull();
  });

  test('rejects a task or client folder naming no entity', () => {
    // `tasks/` and `clients/` are containers, not destinations: a document filed
    // at that level belongs to no task and no client and appears in no listing.
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/tasks/`)).toBeNull();
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/clients/`)).toBeNull();
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/tasks/not-a-uuid/`)).toBeNull();
  });

  test('rejects the firm root itself', () => {
    expect(parseFilingPath(FIRM, `lawfirmids/${FIRM}/`)).toBeNull();
  });

  test('handles missing input without throwing', () => {
    expect(parseFilingPath(null, `lawfirmids/${FIRM}/general/`)).toBeNull();
    expect(parseFilingPath(FIRM, null)).toBeNull();
    expect(parseFilingPath(FIRM, '')).toBeNull();
  });
});

// A spec file exports nothing; the empty export marks it as a MODULE so
// its top-level bindings stay file-scoped rather than colliding across specs.
export {};
