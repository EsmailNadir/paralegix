import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import TemplateCreatePanel from '@/components/templatesComp/TemplateCreatePanel';
import { templatesService } from '@/services/templates.service';

jest.mock('@/services/templates.service', () => ({
  templatesService: {
    uploadOverlay: jest.fn(),
  },
}));

describe('TemplateCreatePanel', () => {
  it('renders standard New Template button initially and shows upload capsule with Cancel button while uploading', async () => {
    let capturedSignal: AbortSignal | undefined;
    (templatesService.uploadOverlay as jest.Mock).mockImplementation(
      (_firmId: string, _file: File, _name?: string, _folderId?: string | null, options?: { signal?: AbortSignal }) => {
        capturedSignal = options?.signal;
        return new Promise(() => {}); // hang
      }
    );

    const onCancel = jest.fn();
    render(
      <TemplateCreatePanel
        lawFirmId="firm-1"
        folderId={null}
        onOverlayCreated={jest.fn()}
        onUnsupportedFile={jest.fn()}
        onUploadFailed={jest.fn()}
        onCancel={onCancel}
      />
    );

    expect(screen.getByText('New Template')).toBeInTheDocument();

    const file = new File(['%PDF-1.4'], 'template.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    // One general label for the whole upload. The percentage it replaced
    // measured only the bytes, which are sent long before the server has
    // finished building the template from them.
    await waitFor(() => {
      expect(screen.getByText('Uploading')).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole('button', { name: 'Cancel upload' });
    expect(cancelButton).toBeInTheDocument();

    fireEvent.click(cancelButton);

    expect(capturedSignal?.aborted).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText('New Template')).toBeInTheDocument();
  });
});
