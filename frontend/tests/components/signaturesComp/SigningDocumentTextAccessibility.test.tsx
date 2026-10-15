import React from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import SigningDocumentText from '@/components/signaturesComp/SigningDocumentText';
import { renderWithProviders } from '../../support/renderWithProviders';

const textDocument = (pages: Array<string[]>) => ({
  numPages: pages.length,
  getPage: jest.fn(async (page: number) => ({ getTextContent: jest.fn(async () => ({ items: pages[page - 1].map(str => ({ str, hasEOL: true })) })) })),
}) as unknown as PDFDocumentProxy;

it('reads all PDF pages as named text sections, including pages outside the raster window', async () => {
  const pdf = textDocument([['Agreement', 'Payment due October 4'], ['Disclosure'], [], ['Final terms']]);
  renderWithProviders(<SigningDocumentText pdf={pdf} />);
  const dialog = await screen.findByRole('region', { name: 'Document text' });
  expect(dialog).toHaveClass('sr-only');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(await within(dialog).findByText('Payment due October 4')).toBeInTheDocument();
  expect(within(dialog).getByRole('heading', { name: 'Page 4' })).toBeInTheDocument();
  expect(within(dialog).getByText('Final terms')).toBeInTheDocument();
  expect(within(dialog).getByText(/No embedded text.*accessible copy/)).toBeInTheDocument();
  expect(pdf.getPage).toHaveBeenCalledTimes(4);
  expect(within(dialog).getByText(/Layout, images, and handwritten content may be missing/)).toBeInTheDocument();
});

it('announces unreadable content and reads a replacement PDF without adding controls', async () => {
  const pdf = textDocument([['Actual readable content']]);
  (pdf.getPage as jest.Mock).mockRejectedValueOnce(new Error('PDF unavailable'));
  const view = renderWithProviders(<SigningDocumentText pdf={pdf} />);
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Unable to read document text'));
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  const replacement = textDocument([['Replacement document']]);
  view.rerender(<SigningDocumentText pdf={replacement} />);
  expect(await screen.findByText('Replacement document')).toBeInTheDocument();
  expect(replacement.getPage).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Actual readable content')).not.toBeInTheDocument();
});
