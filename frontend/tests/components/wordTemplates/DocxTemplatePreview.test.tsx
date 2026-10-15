/**
 * The Word preview draws an uploaded .docx straight into the page, so whatever
 * links and image sources the file carries land in the app's own document.
 *
 * Red if a `javascript:` (or other non-web) link or image source from the file
 * survives the render, or if an ordinary web link or embedded image is lost.
 */
import { render, screen, waitFor } from '@testing-library/react';
import DocxTemplatePreview from '@/components/wordTemplates/DocxTemplatePreview';

jest.mock('@/services/wordTemplates.service', () => ({
  __esModule: true,
  wordTemplatesService: { docxSource: jest.fn(async () => new Blob(['docx'])) },
}));

// Stands in for docx-preview rendering a crafted document: the hyperlinks and
// images below are what a .docx's relationships can point at.
jest.mock('docx-preview', () => ({
  __esModule: true,
  renderAsync: jest.fn(async (_source: Blob, host: HTMLElement) => {
    host.innerHTML = [
      '<a href="javascript:alert(document.cookie)">Click to verify</a>',
      '<a href=" JaVaScRiPt:alert(1)">Spaced</a>',
      '<a href="data:text/html,<script>alert(1)</script>">Data link</a>',
      '<a href="https://example.com/terms">Terms</a>',
      '<a href="mailto:office@example.com">Email</a>',
      '<a href="#bookmark">Section</a>',
      '<img alt="logo" src="data:image/png;base64,iVBORw0KGgo=">',
      '<img alt="tracker" src="javascript:alert(1)">',
      '<svg><a xlink:href="javascript:alert(1)"><text>svg link</text></a></svg>',
    ].join('');
  }),
}));

describe('DocxTemplatePreview', () => {
  it('removes script links and sources a document carries, and keeps ordinary ones', async () => {
    render(<DocxTemplatePreview lawFirmId="firm-1" templateId="tpl-1" />);

    // The render ran: the safe link is on screen with its address intact.
    await waitFor(() => expect(screen.getByText('Terms').getAttribute('href')).toBe('https://example.com/terms'));
    expect(screen.getByText('Email').getAttribute('href')).toBe('mailto:office@example.com');
    expect(screen.getByText('Section').getAttribute('href')).toBe('#bookmark');
    expect(screen.getByAltText('logo').getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');

    expect(screen.getByText('Click to verify').hasAttribute('href')).toBe(false);
    expect(screen.getByText('Spaced').hasAttribute('href')).toBe(false);
    expect(screen.getByText('Data link').hasAttribute('href')).toBe(false);
    expect(screen.getByAltText('tracker').hasAttribute('src')).toBe(false);
    const svgLink = screen.getByText('svg link').closest('a') as Element;
    expect(svgLink.hasAttribute('xlink:href')).toBe(false);
  });
});
