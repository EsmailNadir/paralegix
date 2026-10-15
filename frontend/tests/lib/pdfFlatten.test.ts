import { PDFDocument } from 'pdf-lib';
import { flattenPdf, FLATTEN_MAX_BYTES } from '@/lib/pdfFlatten';

describe('flattenPdf', () => {
  it('flattens form fields and removes AcroForm from the document catalog', async () => {
    // Create an in-memory PDF with an interactive text field
    const pdfDoc = await PDFDocument.create();
    const page = pdfDoc.addPage([400, 400]);
    const form = pdfDoc.getForm();
    const textField = form.createTextField('client_name');
    textField.setText('Jane Doe');
    textField.addToPage(page, { x: 50, y: 300, width: 200, height: 30 });

    const pdfBytes = await pdfDoc.save();
    const buffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;
    const mockFile = new File([buffer], 'test-form.pdf', {
      type: 'application/pdf',
    });

    const result = await flattenPdf(mockFile);

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('test-form.pdf');
    expect(result.fieldsCount).toBe(1);

    // Verify the resulting PDF has no fields in form
    const reloadedDoc = await PDFDocument.load(await result.file.arrayBuffer());
    const reloadedForm = reloadedDoc.getForm();
    expect(reloadedForm.getFields().length).toBe(0);
  });

  it('handles PDFs without form fields gracefully', async () => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.addPage([400, 400]);
    const pdfBytes = await pdfDoc.save();
    const buffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;
    const mockFile = new File([buffer], 'plain.pdf', {
      type: 'application/pdf',
    });

    const result = await flattenPdf(mockFile);

    expect(result.file).toBeInstanceOf(File);
    expect(result.file.name).toBe('plain.pdf');
    expect(result.fieldsCount).toBe(0);
  });

  it('refuses a PDF over the browser ceiling without reading any of it', async () => {
    // pdf-lib holds the whole file and a second, flattened copy in the tab, so
    // a large form could freeze or crash the browser before anything uploads.
    const file = new File(['%PDF-1.7'], 'Large intake.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: 80 * 1024 * 1024 });
    const read = jest.spyOn(file, 'arrayBuffer');

    await expect(flattenPdf(file)).rejects.toThrow(
      'This PDF is 80 MB. Forms can be flattened in your browser up to 50 MB. '
      + 'Open it in your PDF viewer and choose File > Print > Save as PDF to flatten it, then upload that copy.',
    );
    expect(read).not.toHaveBeenCalled();
    expect(FLATTEN_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});

