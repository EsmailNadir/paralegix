/**
 * A text field value is bounded by what a field can show.
 *
 * Every value reaches the text fitter at finalize, which measures each glyph
 * at every size step while it shrinks the text into the box. A value of
 * hundreds of thousands of characters that no box could ever display costs
 * tens of millions of measurements inside the last signer's request.
 * Signature and initials values are PNG data urls and keep their own bounds.
 *
 * What has to break for this to go red: drop the cap (the long value is
 * stored and the signer is marked completed), or apply it to images (the
 * signature value is refused).
 */
import {
  testPool,
  request,
  createFirm,
  ownerOf,
  type Actor,
  type Firm,
} from '../support/setupInProcess';
import { objects, installInMemoryBucket } from '../support/inMemoryBucket';
import { minimalPdf } from '../support/minimalPdf';
import {
  seedSigningSession, storeSigningSource, completionBody, SIGNATURE_DATA_URL,
} from '../support/signing';

installInMemoryBucket();

/** The cap, stated here rather than imported, so a missing export is a failure too. */
const TEXT_CAP = 5_000;

let firm: Firm;
let owner: Actor;

async function seedSession() {
  const objectPath = await storeSigningSource(firm.id, minimalPdf({ pages: 1 }).bytes);
  const { participants: [signer] } = await seedSigningSession({
    lawFirmId: firm.id,
    createdBy: owner.uid,
    session: {
      routing_mode: 'sequential',
      object_path: objectPath,
      current_signer_order: 1,
      document_hash: 'originalhash',
    },
    participants: [{
      name: 'Signer One',
      roleLabel: 'Signer',
      email: 'signer@example.test',
      fields: (['text', 'signature'] as const).map((fieldType, order) => ({
        fieldType, label: 'Field', xPercent: 20 + order * 20, yPercent: 30,
      })),
    }],
  });
  const [text, signature] = signer.fieldIds;
  return { publicToken: signer.publicToken, participantId: signer.participantId, fields: { text, signature } };
}

async function submit(seeded: Awaited<ReturnType<typeof seedSession>>, text: string) {
  const page = await request().get(`/api/signing/${seeded.publicToken}`);
  return request()
    .post(`/api/signing/${seeded.publicToken}/complete`)
    .set('Content-Type', 'application/json')
    .send(completionBody({
      sourceRevision: page.body.sourceRevision,
      fieldValues: [
        { fieldId: seeded.fields.text, value: text },
        { fieldId: seeded.fields.signature, value: SIGNATURE_DATA_URL },
      ],
    }));
}

const participant = async (participantId: string) => (await testPool.query(
  'select status, field_values from signature_participants where id = $1', [participantId],
)).rows[0];

beforeEach(async () => {
  objects.clear();
  firm = await createFirm({ name: 'Hale & Co' });
  owner = await ownerOf(firm.id);
});

describe('text field values', () => {
  it('refuses a text value longer than a field can hold, before anything is stored', async () => {
    const seeded = await seedSession();
    const res = await submit(seeded, 'x'.repeat(TEXT_CAP + 1));

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SIGNING_TEXT_TOO_LONG');
    const row = await participant(seeded.participantId);
    expect(row.status).toBe('active');
    expect(row.field_values).toBeNull();
  });

  it('accepts a text value exactly at the cap', async () => {
    const seeded = await seedSession();
    const res = await submit(seeded, 'x'.repeat(TEXT_CAP));
    expect(res.status).toBe(200);
    expect((await participant(seeded.participantId)).status).toBe('completed');
  });
});
