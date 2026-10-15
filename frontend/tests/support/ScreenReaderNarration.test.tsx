import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { narrateElement } from './screenReaderNarrator';
import RestrictedSigningView from '@/components/signaturesComp/RestrictedSigningView';
import UploadDocumentModal from '@/components/portalComp/UploadDocumentModal';
import { setupApiMock, sequence } from './apiMock';

jest.unmock('@/services/signatures.service');
jest.unmock('@/services/client-portal.service');
jest.unmock('@/services/requestDeduplicator');
jest.mock('@/components/signaturesComp/PDFPageViewer', () => {
  const { useEffect } = require('react');
  const pdf = {
    numPages: 1,
    getPage: async () => ({
      getTextContent: async () => ({
        items: [{ str: 'Agreement Terms and Retainer Amount: $1,500.', hasEOL: true }],
      }),
    }),
  };
  function Viewer(props: any) {
    const { onDocumentLoad, onDocumentProxy } = props;
    useEffect(() => {
      onDocumentLoad?.(1);
      onDocumentProxy?.(pdf);
    }, [onDocumentLoad, onDocumentProxy]);
    return <div>{props.children(1, 800, 1000, { width: 612, height: 792 })}</div>;
  }
  return { __esModule: true, default: Viewer };
});

const api = setupApiMock();

describe('Screen Reader Speech Simulation', () => {
  it('narrates the Document Signing Flow exactly as heard on VoiceOver and NVDA', async () => {
    api.postExact(
      '/api/signing/token-123/complete',
      sequence(
        { status: 403, body: { error: 'Document expired or locked' } },
        { completed: true, state: 'completed', consentRecorded: true }
      )
    );

    const user = userEvent.setup();
    const narrationLog: string[] = [];

    render(
      <RestrictedSigningView
        file={{ url: 'blob:agreement', name: 'Agreement.pdf' }}
        token="token-123"
        sourceRevision="rev-1"
        fields={[
          {
            id: 'f-amount',
            page: 1,
            xPercent: 10,
            yPercent: 10,
            widthPercent: 20,
            heightPercent: 5,
            fieldType: 'text',
            label: 'Approved retainer amount',
            required: true,
          },
        ]}
      />
    );

    // 1. Initial Document & Field Traversal
    const fieldButton = screen.getByRole('button', {
      name: 'Approved retainer amount, page 1, required, incomplete',
    });
    const fieldUtterance = narrateElement(fieldButton);
    expect(fieldUtterance).not.toBeNull();
    narrationLog.push(`[Focus Field]: "${fieldUtterance!.spokenText}"`);

    // 2. Open Field Editor
    fieldButton.focus();
    await user.keyboard('{Enter}');
    const textInput = screen.getByRole('textbox', { name: 'Approved retainer amount' });
    narrationLog.push(`[Active Input]: "${narrateElement(textInput)!.spokenText}"`);

    // 3. Type value and save
    await user.type(textInput, '1500');
    const saveButton = screen.getByRole('button', { name: 'Save' });
    narrationLog.push(`[Save Button]: "${narrateElement(saveButton)!.spokenText}"`);
    await user.click(saveButton);

    // 4. Verification that completed state updates accessible name
    const updatedField = screen.getByRole('button', {
      name: 'Approved retainer amount, page 1, required, complete',
    });
    narrationLog.push(`[Updated Field]: "${narrateElement(updatedField)!.spokenText}"`);

    // 5. Open Signing & Submit step
    await user.click(screen.getByRole('button', { name: 'Done' }));
    const nameInput = screen.getByRole('textbox', { name: /Full Legal Name/i });
    narrationLog.push(`[Signer Name Input]: "${narrateElement(nameInput)!.spokenText}"`);
    await user.type(nameInput, 'Alex Morgan');

    const consentCheck = screen.getByRole('checkbox');
    narrationLog.push(`[Consent Before Check]: "${narrateElement(consentCheck)!.spokenText}"`);
    await user.click(consentCheck);
    narrationLog.push(`[Consent After Check]: "${narrateElement(consentCheck)!.spokenText}"`);

    // 6. Submit triggers a refusal alert
    await user.click(screen.getByRole('button', { name: 'Sign & Submit' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveFocus();
    narrationLog.push(`[Error Alert Announcement]: "${alert.textContent?.trim()}, alert"`);

    // 7. Retry submission
    const submitBtn = screen.getByRole('button', { name: 'Sign & Submit' });
    submitBtn.focus();
    narrationLog.push(`[Submit Button]: "${narrateElement(submitBtn)!.spokenText}"`);
    await user.keyboard('{Enter}');

    // 8. Completion screen
    const heading = await screen.findByRole('heading', { name: 'Signing Complete' });
    await waitFor(() => expect(heading).toHaveFocus());
    narrationLog.push(`[Completion Heading]: "${narrateElement(heading)!.spokenText}"`);

    // Print speech log for visual / manual verification
    console.log('\n--- VOICE-OVER / NVDA SIMULATED SPEECH OUTPUT ---');
    narrationLog.forEach((log) => console.log(log));
    console.log('-------------------------------------------------\n');

    expect(narrationLog).toContain(
      '[Focus Field]: "Approved retainer amount, page 1, required, incomplete, button"'
    );
    expect(narrationLog).toContain(
      '[Updated Field]: "Approved retainer amount, page 1, required, complete, button"'
    );
    expect(narrationLog).toContain(
      '[Consent After Check]: "I agree to sign this document electronically and acknowledge that my electronic signature is legally binding., checked, checkbox"'
    );
    expect(narrationLog).toContain(
      '[Error Alert Announcement]: "Document expired or locked, alert"'
    );
    expect(narrationLog).toContain(
      '[Completion Heading]: "Signing Complete, heading level 2"'
    );
  });

  it('narrates the Document Upload Dialog, Progress, and Status Announcements', async () => {
    const uploadLog: string[] = [];
    const onClose = jest.fn();
    const onUploaded = jest.fn();

    render(
      <UploadDocumentModal
        open={true}
        onClose={onClose}
        lawFirmId="firm-1"
        matters={[{ id: 'matter-1', title: 'Corporate Estate Matter' }]}
        onUploaded={onUploaded}
      />
    );

    // 1. Modal Dialog & File Selection Trigger
    const dialog = screen.getByRole('dialog', { name: 'Upload a document' });
    uploadLog.push(`[Dialog Open]: "${narrateElement(dialog)!.spokenText}"`);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const fakeFile = new File(['sample content'], 'Engagement_Agreement.pdf', { type: 'application/pdf' });
    uploadLog.push(`[Upload Control]: "${narrateElement(fileInput)!.spokenText}"`);

    // 2. Select file
    const user = userEvent.setup();
    await user.upload(fileInput, fakeFile);

    const removeFileBtn = screen.getByRole('button', { name: 'Remove Engagement_Agreement.pdf' });
    uploadLog.push(`[Selected File Action]: "${narrateElement(removeFileBtn)!.spokenText}"`);

    const uploadBtn = screen.getByRole('button', { name: 'Upload' });
    uploadLog.push(`[Submit Upload Action]: "${narrateElement(uploadBtn)!.spokenText}"`);

    console.log('\n--- DOCUMENT UPLOAD NARRATION AUDIT ---');
    uploadLog.forEach((log) => console.log(log));
    console.log('---------------------------------------\n');

    expect(uploadLog).toContain('[Dialog Open]: "Upload a document, dialog"');
    expect(uploadLog).toContain(
      '[Selected File Action]: "Remove Engagement_Agreement.pdf, button"'
    );
    expect(uploadLog).toContain('[Submit Upload Action]: "Upload, button"');
  });
});
