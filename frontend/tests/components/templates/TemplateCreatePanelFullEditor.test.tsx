import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import TemplateCreatePanel from '@/components/templatesComp/TemplateCreatePanel';
import { templatesService } from '@/services/templates.service';

jest.mock('@/services/templates.service', () => ({
  templatesService: {
    uploadOverlay: jest.fn(),
  },
}));

// In the Full editor version a picked document is handed to the full editor
// as it is: nothing is uploaded and no overlay draft row is created.
describe('TemplateCreatePanel in the Full editor version', () => {
  beforeEach(() => (templatesService.uploadOverlay as jest.Mock).mockClear());

  const renderPanel = (onDocumentPicked = jest.fn(), onUnsupportedFile = jest.fn()) => {
    render(
      <TemplateCreatePanel
        lawFirmId="firm-1"
        folderId="folder-2"
        mode="full-editor"
        onDocumentPicked={onDocumentPicked}
        onOverlayCreated={jest.fn()}
        onUnsupportedFile={onUnsupportedFile}
        onUploadFailed={jest.fn()}
      />
    );
    return { onDocumentPicked, onUnsupportedFile };
  };

  it('hands the picked file to the full editor without uploading an overlay', () => {
    const { onDocumentPicked } = renderPanel();
    const file = new File(['PK'], 'engagement.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    expect(onDocumentPicked).toHaveBeenCalledWith(file);
    expect(templatesService.uploadOverlay).not.toHaveBeenCalled();
    expect(screen.getByText(/full editor/i)).toBeInTheDocument();
  });

  it('still refuses a format the editor cannot import', () => {
    const { onDocumentPicked, onUnsupportedFile } = renderPanel();
    const file = new File(['x'], 'photo.png', { type: 'image/png' });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    expect(onUnsupportedFile).toHaveBeenCalledWith(
      "photo.png isn't a supported format. Use PDF, DOCX, DOC, ODT, RTF, or TXT."
    );
    expect(onDocumentPicked).not.toHaveBeenCalled();
  });
});
