import { randomUUID } from 'crypto';
import { requireOk, StepFailed } from '../client';
import { DOCX_TYPE, SIGNATURE_DATA_URL } from '../fixtures';
import { sleep, type Vu } from '../vu';

const COMPLETION_WAIT_MS = 90_000;

/**
 * One signature box and one typed-name box on page 1, both for the one signer.
 * Field ids are the primary key of `signature_fields` across every firm, so
 * each session needs fresh ones, as the browser generates.
 */
const fieldsFor = (participantId: string) => {
  const signatureId = randomUUID();
  const nameId = randomUUID();
  return {
    signatureId,
    nameId,
    fields: [
      { id: signatureId, page: 1, xPercent: 10, yPercent: 70, widthPercent: 30, heightPercent: 8, fieldType: 'signature', signerId: participantId },
      { id: nameId, page: 1, xPercent: 10, yPercent: 82, widthPercent: 30, heightPercent: 4, fieldType: 'text', signerId: participantId },
    ],
  };
};

/**
 * The whole e-signature lifecycle for one document: upload, prepare a copy
 * link (no email is sent), sign as the recipient, and download the sealed PDF.
 * Signer calls carry no Firebase token because the signing token is the
 * signer's only credential.
 */
export async function signingRoundTrip(vu: Vu, pdf: Buffer): Promise<void> {
  const { api, lawFirmId } = vu;
  const name = `stress-${vu.index}.pdf`;

  const init = requireOk(
    await api.call('esign.uploadInit', 'POST', '/api/signing/upload-init', { lawFirmId, name, size: pdf.length, contentType: 'application/pdf' }),
    'esign.uploadInit',
  );
  requireOk(await api.upload('esign.uploadPut', init.uploadUrl, pdf, 'application/pdf'), 'esign.uploadPut');
  const finalized = requireOk(
    await api.call('esign.uploadFinalize', 'POST', '/api/signing/upload-finalize', { lawFirmId, objectPath: init.objectPath }),
    'esign.uploadFinalize',
  );

  const participantId = randomUUID();
  const layout = fieldsFor(participantId);
  const link = requireOk(
    await api.call('esign.generate', 'POST', `/api/lawfirms/${lawFirmId}/signature-links/generate`, {
      objectPath: finalized.objectPath,
      fileName: init.fileName,
      fields: layout.fields,
      signers: [{
        participantId,
        roleLabel: 'Client',
        order: 1,
        deliveryMethod: 'copy_link',
        name: 'Stress Signer',
        email: `signer-${vu.index}@stress.paralegix.test`,
      }],
    }),
    'esign.generate',
  );
  // The signer acts with the participant token; the firm reads results by session token.
  const token = link.token;

  const view = requireOk(await api.call('esign.signerView', 'GET', `/api/signing/${token}`, undefined, { auth: false }), 'esign.signerView');
  requireOk(await api.call('esign.signerFile', 'GET', `/api/signing/${token}/file`, undefined, { auth: false }), 'esign.signerFile');

  const done = await api.call('esign.complete', 'POST', `/api/signing/${token}/complete`, {
    consentAgreed: true,
    consentName: 'Stress Signer',
    consentTimestamp: new Date().toISOString(),
    sourceRevision: view.sourceRevision,
    idempotencyKey: randomUUID(),
    fieldValues: [
      { fieldId: layout.signatureId, value: SIGNATURE_DATA_URL },
      { fieldId: layout.nameId, value: 'Stress Signer' },
    ],
  }, { auth: false });
  requireOk(done, 'esign.complete', [200, 202]);
  if (done.status === 202) await waitForCompletion(vu, token);

  requireOk(await api.call('esign.download', 'GET', `/api/signing/${link.sessionToken}/signed-document?format=json`), 'esign.download');
}

/** A 202 means sealing went to the durable job; poll until it lands. */
async function waitForCompletion(vu: Vu, token: string): Promise<void> {
  const deadline = Date.now() + COMPLETION_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    const status = requireOk(
      await vu.api.call('esign.status', 'GET', `/api/signing/${token}/status`, undefined, { auth: false }),
      'esign.status',
    );
    if (status.sessionStatus === 'completed') return;
  }
  throw new StepFailed(`esign.complete did not finish within ${COMPLETION_WAIT_MS / 1000}s`);
}

/** A Word file sent for signature: the document worker converts it to PDF. */
export async function convertDocxForSigning(vu: Vu, docx: Buffer): Promise<void> {
  const { api, lawFirmId } = vu;
  const name = `stress-${vu.index}.docx`;
  const init = requireOk(
    await api.call('esign.convertInit', 'POST', '/api/signing/convert-upload-init', { lawFirmId, name, contentType: DOCX_TYPE, size: docx.length }),
    'esign.convertInit',
  );
  requireOk(await api.upload('esign.convertPut', init.uploadUrl, docx, DOCX_TYPE), 'esign.convertPut');
  requireOk(
    await api.call('esign.convertFinalize', 'POST', '/api/signing/convert-upload-finalize', { lawFirmId, objectPath: init.objectPath, name }),
    'esign.convertFinalize',
  );
}
