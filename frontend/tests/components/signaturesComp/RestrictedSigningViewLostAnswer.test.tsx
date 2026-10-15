/**
 * The field-driven signing page when the completion's answer is lost.
 *
 * Under load the gateway can give up on `POST /complete` (504) after the server
 * has already recorded the signature. The page used to say "the server took too
 * long, try again", so a signer who HAD signed was asked to sign again, or left
 * believing they had not. These cases run the real service against the
 * transport fake, so they fail if either the service stops asking the status
 * route or the page stops trusting what it answers.
 */
jest.unmock('@/services/signatures.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/components/signaturesComp/PDFPageViewer', () => {
  const { useEffect } = require('react');
  function FakePDFPageViewer(props: any) {
    useEffect(() => {
      props.onDocumentLoad?.(1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <div>{props.children(1, 800, 1000, { width: 612, height: 792 })}</div>;
  }
  return { __esModule: true, default: FakePDFPageViewer };
});

jest.mock('@/components/signaturesComp/SignatureModal', () => ({
  __esModule: true,
  default: (props: any) =>
    props.isOpen ? (
      <button type="button" onClick={() => props.onDone('data:image/png;base64,test', 'default')}>
        Complete signature
      </button>
    ) : null,
}));

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import RestrictedSigningView from '@/components/signaturesComp/RestrictedSigningView';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import type { SignatureField } from '@/types/signature';

const TOKEN = 'tok-1';
const COMPLETE = `/signing/${TOKEN}/complete`;
const STATUS = `/signing/${TOKEN}/status`;

const FIELD: SignatureField = {
  id: 'field-1', page: 1, xPercent: 10, yPercent: 10, widthPercent: 20, heightPercent: 5,
  fieldType: 'signature', required: true,
};

let api: ApiMock;

beforeEach(() => {
  api = installApiMock();
});

afterEach(() => {
  api.restore();
});

function signAndSubmit() {
  render(
    <RestrictedSigningView
      file={{ url: 'blob:test', name: 'Agreement.pdf' }}
      fields={[FIELD]}
      token={TOKEN}
      sourceRevision="rev-1"
    />,
  );
  fireEvent.click(screen.getByTitle('Signature'));
  fireEvent.click(screen.getByRole('button', { name: 'Complete signature' }));
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.change(screen.getByPlaceholderText('Enter your full legal name'), { target: { value: 'Jane Doe' } });
  fireEvent.click(screen.getByRole('button', { name: /Sign & Submit/ }));
}

it('shows the signature as recorded when the completion timed out but the status says it landed', async () => {
  api.post(COMPLETE, { status: 504, body: { error: 'upstream request timeout' } });
  api.get(STATUS, sequence(
    { sessionStatus: 'in_progress', participantStatus: 'completed', totalParticipants: 1, completedParticipants: 1 },
  ));

  signAndSubmit();

  expect(await screen.findByText('Signing Complete')).toBeInTheDocument();
  expect(screen.getByText(/still being produced/i)).toBeInTheDocument();
  expect(screen.queryByText(/took too long/i)).not.toBeInTheDocument();
  // Recorded once. A second completion was never needed.
  expect(api.callsTo(COMPLETE)).toHaveLength(1);
});

it('sends the completion once more with the same key when the status says it did not land', async () => {
  api.post(COMPLETE, sequence(
    { status: 504, body: { error: 'upstream request timeout' } },
    { success: true, state: 'completed', completed: true, consentRecorded: true },
  ));
  api.get(STATUS, { sessionStatus: 'in_progress', participantStatus: 'active', totalParticipants: 1, completedParticipants: 0 });

  signAndSubmit();

  // The retry waits out a short settle window first, so the request it repeats
  // can finish on the server before a second one competes with it.
  expect(await screen.findByText('Signing Complete', {}, { timeout: 4000 })).toBeInTheDocument();
  const posts = api.callsTo(COMPLETE);
  expect(posts).toHaveLength(2);
  expect((posts[1].body as any).idempotencyKey).toBe((posts[0].body as any).idempotencyKey);
});
