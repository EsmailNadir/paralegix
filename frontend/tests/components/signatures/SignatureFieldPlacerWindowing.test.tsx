/**
 * Placing a field in a long document, over the REAL windowed viewer.
 *
 * `SignatureFieldPlacer.test.tsx` stubs the viewer out, which is right for the
 * signer and reducer rules it covers but means it would not notice the viewer
 * dropping and remounting pages underneath it. This file keeps the real viewer
 * and only mocks `react-pdf`, because the risk being covered is exactly the
 * seam between them: a field is a percentage of a page whose canvas comes and
 * goes, and if that page's box is ever re-derived from what is currently drawn,
 * the field lands somewhere else in the executed PDF. Nothing on screen shows
 * that; the first sign of it is a signature block printed over a paragraph.
 */
import React from 'react';
import userEvent from '@testing-library/user-event';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../../support/renderWithProviders';
import {
  createCanvasTracker,
  installIntersectionControl,
  installMeasuringResizeObserver,
  installPointerEvents,
  trackedCanvas,
  type IntersectionControl,
} from '../../support/pdfWindowHarness';

const PAGE_COUNT = 1000;
const tracker = createCanvasTracker();

jest.mock('react-pdf', () => ({
  __esModule: true,
  pdfjs: { GlobalWorkerOptions: {} },
  Document: function MockDocument({ children, onLoadSuccess }: any) {
    const fired = React.useRef(false);
    React.useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      onLoadSuccess?.({ numPages: PAGE_COUNT });
    });
    return <div data-testid="document">{children}</div>;
  },
  Page: () => null,
}));

jest.mock('@/components/ui/PdfCanvasPage', () => ({
  __esModule: true,
  default: trackedCanvas(() => tracker, jest.requireActual('react')),
}));

// `tests/setup.ts` replaces the viewer with `() => null` for the whole suite,
// because `react-pdf` is ESM Jest cannot parse. This spec is about what the
// placer does ON TOP of the real viewer, so it puts the real one back while
// leaving the `react-pdf` mock above in place underneath it. `jest.unmock` will
// not do it: setup registers an explicit factory, not an automock.
jest.mock('@/components/signaturesComp/PDFPageViewer', () =>
  jest.requireActual('@/components/signaturesComp/PDFPageViewer'));

const mockSendSigningRequest = jest.fn().mockResolvedValue({});
const mockListSigningRecipients = jest.fn();

jest.mock('@/services/signatures.service', () => ({
  __esModule: true,
  default: {
    getSigningTemplate: jest.fn(),
    createSigningTemplate: jest.fn().mockResolvedValue({}),
    sendSigningRequest: (...args: any[]) => mockSendSigningRequest(...args),
    listSigningRecipients: (...args: any[]) => mockListSigningRecipients(...args),
  },
}));

jest.mock('@/services/clients.service', () => ({
  __esModule: true,
  default: { lookupClients: jest.fn().mockResolvedValue({ items: [], hasMore: false }) },
}));

jest.mock('@/services/lawfirm.service', () => ({
  __esModule: true,
  default: { getLawFirmMembers: jest.fn().mockResolvedValue([]) },
}));

jest.mock('@/components/signaturesComp/SignatureVisual', () => ({
  __esModule: true,
  default: () => <div>Signature placeholder</div>,
}));

jest.mock('@/components/signaturesComp/DestinationPickerModal', () => ({
  __esModule: true,
  default: () => null,
}));

import SignatureFieldPlacer from '@/components/signaturesComp/SignatureFieldPlacer';

/** The rect a real layout would give a page, so a pointer maps to a percentage. */
const PAGE_RECT = {
  left: 100, right: 900, top: 0, bottom: 1000, width: 800, height: 1000,
} as DOMRect;

let intersection: IntersectionControl;
let restoreResize: () => void;
let restorePointerEvents: () => void;

beforeEach(() => {
  tracker.reset();
  mockSendSigningRequest.mockClear();
  mockSendSigningRequest.mockResolvedValue({});
  mockListSigningRecipients.mockReset();
  mockListSigningRecipients.mockResolvedValue({
    items: [{
      userId: 'firebase-uid-abc',
      name: 'Ada Client',
      email: 'ada@example.com',
      clientId: 'client-row-id',
      clientName: 'Ada Client',
      clientType: 'person' as const,
      companyLinkId: null,
      companyName: null,
    }],
    hasMore: false,
  });
  restoreResize = installMeasuringResizeObserver(800);
  restorePointerEvents = installPointerEvents();
  intersection = installIntersectionControl((page) => `[data-pdf-page="${page}"]`);
});

afterEach(() => {
  intersection.restore();
  restoreResize();
  restorePointerEvents();
});

function renderPlacer() {
  return renderWithProviders(
    <SignatureFieldPlacer
      file={{ url: 'https://example.com/production.pdf', name: 'production.pdf', bytes: new Uint8Array([1, 2, 3]) }}
      lawFirmId="law-firm-1"
      objectPath="signatures/production.pdf"
      onBack={jest.fn()}
    />,
  );
}

function scrollToPage(page: number) {
  act(() => {
    intersection.scrollTo({ [page]: 1 });
  });
}

/** Clicks a spot on a page's box, which is how a field is placed. */
function placeFieldOnPage(page: number, offsetX: number, offsetY: number) {
  const box = document.querySelector(`[data-pdf-page="${page}"]`) as HTMLElement;
  box.getBoundingClientRect = () => PAGE_RECT;
  fireEvent.pointerDown(box, {
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse',
    clientX: PAGE_RECT.left + offsetX,
    clientY: PAGE_RECT.top + offsetY,
  });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType: 'mouse' });
}

it('sends the coordinates a field was placed at, after scrolling the page out of the window and back', async () => {
  const user = userEvent.setup();
  renderPlacer();

  await user.click(await screen.findByRole('button', { name: /send via email/i }));
  await user.click(await screen.findByRole('option', { name: 'Send in Paralegix' }));
  await user.click(await screen.findByRole('button', { name: /search portal clients and team/i }));
  await user.click(await screen.findByRole('option', { name: /Ada Client/ }));
  await user.click(screen.getByRole('button', { name: /continue to place fields/i }));

  await waitFor(() => expect(document.querySelector('[data-pdf-page="1"]')).not.toBeNull());
  // 200 of 800 across and 300 of 1000 down.
  placeFieldOnPage(1, 200, 300);

  await waitFor(() => expect(document.querySelector('[data-annotation]')).not.toBeNull());

  // Read on, far enough that page 1's canvas is dropped, then come back.
  scrollToPage(900);
  expect(screen.queryByTestId('canvas-1')).not.toBeInTheDocument();
  expect(tracker.count()).toBeLessThanOrEqual(5);
  scrollToPage(1);
  expect(screen.getByTestId('canvas-1')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: /^continue$/i }));
  await user.click(screen.getByRole('button', { name: /send for signing/i }));

  await waitFor(() => expect(mockSendSigningRequest).toHaveBeenCalled());
  const [, payload] = mockSendSigningRequest.mock.calls[0];
  expect(payload.fields).toHaveLength(1);
  expect(payload.fields[0]).toMatchObject({ page: 1, xPercent: 25, yPercent: 30 });
});

it('keeps a placed field on screen while its own page is not drawn', async () => {
  const user = userEvent.setup();
  renderPlacer();

  await user.click(await screen.findByRole('button', { name: /send via email/i }));
  await user.click(await screen.findByRole('option', { name: 'Send in Paralegix' }));
  await user.click(await screen.findByRole('button', { name: /search portal clients and team/i }));
  await user.click(await screen.findByRole('option', { name: /Ada Client/ }));
  await user.click(screen.getByRole('button', { name: /continue to place fields/i }));

  await waitFor(() => expect(document.querySelector('[data-pdf-page="1"]')).not.toBeNull());
  placeFieldOnPage(1, 200, 300);
  await waitFor(() => expect(document.querySelector('[data-annotation]')).not.toBeNull());

  const before = (document.querySelector('[data-annotation]') as HTMLElement).style.left;
  scrollToPage(400);

  // Page 1 has no canvas now. Its field is still in the document at the same
  // offset, because the field is positioned from the page's box rather than
  // from anything the canvas provides.
  expect(screen.queryByTestId('canvas-1')).not.toBeInTheDocument();
  const after = document.querySelector('[data-annotation]') as HTMLElement;
  expect(after).not.toBeNull();
  expect(after.style.left).toBe(before);
});
