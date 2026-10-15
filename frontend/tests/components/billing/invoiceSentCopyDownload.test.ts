/**
 * Downloading a preserved copy of a sent invoice.
 *
 * The API answers with a short-lived signed url rather than the PDF, so the
 * bytes go storage to browser and never through the API container. This service
 * used to pull the whole document into a Blob, which held it in the page as
 * well as in the server that sent it.
 *
 * Nothing was covering this method at all, which is why the Blob survived a
 * previous pass over the download paths. The cases below are what a reader
 * cannot see from the method's signature:
 *
 *   No Blob is created. That is the memory claim, and it is invisible from the
 *   outside because both versions end with a click on an anchor.
 *
 *   The anchor points at the signed url. Pointing it at the API route again
 *   would download the JSON envelope as a file called "sent-copies".
 *
 *   A refusal throws rather than silently doing nothing, since a download that
 *   quietly fails looks to the user like a slow one.
 */
jest.unmock('@/services/billing.service');
jest.unmock('@/services/requestDeduplicator');

import { installApiMock, type ApiMock } from '../../support/apiMock';
import billingService from '@/services/billing.service';

const FIRM = 'firm-1';
const INVOICE = 'inv-1';
const COPY = 'sent-2026-03-15T10-00-00.pdf';
const SIGNED = 'https://storage.googleapis.com/signed/invoice.pdf?X-Goog-Signature=abc';
const ROUTE = `/billing/invoices/${INVOICE}/sent-copies/${encodeURIComponent(COPY)}`;

let api: ApiMock;
let created: HTMLAnchorElement[];
let createObjectURL: jest.Mock;

beforeEach(() => {
  api = installApiMock();
  created = [];
  const realCreate = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = realCreate(tag);
    if (tag === 'a') {
      // Clicking a real anchor in jsdom navigates and logs a noisy error.
      (el as HTMLAnchorElement).click = jest.fn();
      created.push(el as HTMLAnchorElement);
    }
    return el;
  });
  createObjectURL = jest.fn(() => 'blob:fake');
  Object.defineProperty(window.URL, 'createObjectURL', { configurable: true, value: createObjectURL });
  Object.defineProperty(window.URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
});

afterEach(() => {
  jest.restoreAllMocks();
  api.restore();
});

it('points the download at the signed url', async () => {
  api.get(ROUTE, { signedUrl: SIGNED, fileName: 'Invoice INV-1 - sent 2026-03-15.pdf', size: 4096 });

  await billingService.downloadInvoiceSentCopy(FIRM, INVOICE, COPY);

  // Pointing it back at the API route would save the JSON envelope as a file.
  expect(created[0].href).toBe(SIGNED);
  expect(created[0].click).toHaveBeenCalled();
});

it('never pulls the document into the page', async () => {
  api.get(ROUTE, { signedUrl: SIGNED, fileName: 'x.pdf', size: 4096 });

  await billingService.downloadInvoiceSentCopy(FIRM, INVOICE, COPY);

  // The memory claim, and the only way to see it: both the old and new versions
  // end with a click on an anchor, so the Blob is what tells them apart.
  expect(createObjectURL).not.toHaveBeenCalled();
});

it('throws when the copy is refused', async () => {
  api.get(ROUTE, { status: 403, body: { error: 'Forbidden' } });

  // A download that quietly does nothing reads to the user as a slow one.
  await expect(billingService.downloadInvoiceSentCopy(FIRM, INVOICE, COPY)).rejects.toBeDefined();
  expect(created).toEqual([]);
});

it('throws when the server answers without a url', async () => {
  api.get(ROUTE, { fileName: 'x.pdf' });

  await expect(billingService.downloadInvoiceSentCopy(FIRM, INVOICE, COPY)).rejects.toThrow();
  expect(created).toEqual([]);
});
