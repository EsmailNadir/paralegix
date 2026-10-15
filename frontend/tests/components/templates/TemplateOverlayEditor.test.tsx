/**
 * The Document Overlay editor against the real templates service, with only
 * the transport and the PDF canvas faked. The canvas fake renders page 1 at
 * US Letter so the boxes lay out in real percentages, which is what the fit
 * and the keyboard nudges are computed against.
 */
jest.unmock('@/services/templates.service');
jest.unmock('@/services/requestDeduplicator');

jest.mock('@/components/templatesComp/PlaceholderModal', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('@/components/signaturesComp/PDFPageViewer', () => {
  const React = require('react');
  return {
    __esModule: true,
    default: function FakePDFPageViewer({ children, onDocumentLoad }: any) {
      React.useEffect(() => { onDocumentLoad?.(1); }, [onDocumentLoad]);
      return React.createElement(
        'div',
        { 'data-pdf-page': '1', style: { position: 'relative', width: 612, height: 792 } },
        children?.(1, 612, 792, { width: 612, height: 792 }),
      );
    },
  };
});

import React from 'react';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { installApiMock, sequence, type ApiMock } from '../../support/apiMock';
import { renderWithProviders } from '../../support/renderWithProviders';
import { installPointerEvents } from '../../support/pdfWindowHarness';
import TemplateOverlayEditor from '@/components/templatesComp/TemplateOverlayEditor';

const FIRM = 'firm-1';
const TEMPLATE = 'tpl-1';

const richText = [
  {
    bullet: false,
    runs: [
      { text: 'Dear ', bold: false, italic: false, color: '#000000' },
      { text: '{salutation}', fieldName: 'salutation', bold: true, italic: false, color: '#000000' },
    ],
  },
];

const textBox = {
  id: 'pl-1',
  templateId: TEMPLATE,
  fieldName: 'Dear {salutation}',
  fieldType: 'textbox',
  page: 1,
  xPercent: 10,
  yPercent: 10,
  widthPercent: 40,
  heightPercent: 6,
  repeaterName: null,
  repeaterRowIndex: null,
  sortOrder: 0,
  textContent: 'Dear {salutation}',
  richText,
  imageObjectPath: null,
  imageMimeType: null,
  imagePreviewUrl: null,
  fontSize: 12,
  fontFamily: 'times',
  bold: false,
  italic: false,
  color: '#000000',
  textAlign: 'left',
  bulletList: false,
};

let api: ApiMock;

// jsdom has no canvas. The field box measures its text through one, so the
// stand-in makes every glyph half an em wide: deterministic, and wide enough
// that a long line really does wrap and shrink.
beforeAll(() => {
  // jsdom has no execCommand either; the editable box sets its paragraph
  // separator through it on focus.
  document.execCommand = jest.fn();
  HTMLCanvasElement.prototype.getContext = function getContext() {
    let font = '';
    return {
      set font(value: string) { font = value; },
      get font() { return font; },
      measureText: (text: string) => ({ width: text.length * (parseFloat(font) || 10) * 0.5 }),
    };
  } as any;
});

const templateBody = {
  template: { id: TEMPLATE, name: 'Retainer', type: 'overlay', fields: [], repeaters: [], overlayPdfUrl: 'https://files.test/overlay.pdf' },
};

function saveResponse(call: any) {
  return {
    placements: (call.body as any).placements.map((p: any, index: number) => ({ ...p, id: `saved-${index}`, templateId: TEMPLATE })),
    repeaters: [],
    fields: ['salutation'],
  };
}

function serve(placements: any[], overrides: { template?: any; pdf?: any; put?: any } = {}) {
  api = installApiMock();
  api.get(`/templates/${TEMPLATE}`, overrides.template ?? templateBody);
  api.get(`/templates/${TEMPLATE}/placements`, { placements });
  api.get('/overlay.pdf', overrides.pdf ?? { status: 200, text: '%PDF-1.4', headers: { 'content-type': 'application/pdf' } });
  api.put(`/templates/${TEMPLATE}/placements`, overrides.put ?? saveResponse);
}

function renderEditor() {
  return renderWithProviders(
    <TemplateOverlayEditor lawFirmId={FIRM} templateId={TEMPLATE} onSaved={jest.fn()} onBack={jest.fn()} />,
  );
}

async function saveLayout() {
  fireEvent.click(await screen.findByRole('button', { name: /save layout/i }));
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(api.callsTo(`/templates/${TEMPLATE}/placements`).filter((c) => c.method === 'PUT')).toHaveLength(1));
  return api.callsTo(`/templates/${TEMPLATE}/placements`).find((c) => c.method === 'PUT')!;
}

afterEach(() => {
  api.restore();
});

describe('TemplateOverlayEditor', () => {
  it('saves a text box with the rich runs it was authored with', async () => {
    serve([textBox]);
    renderEditor();
    await screen.findByText('1 field placed');

    const save = await saveLayout();

    // Without the runs the server stores the flat mirror only: every bold,
    // color and field chip is gone, and "{salutation}" prints as literal text.
    const saved = (save.body as any).placements[0];
    expect(saved.richText).toEqual(richText);
    expect(saved.textContent).toBeNull();
    // The fillable list comes back from the server, chips included.
    const strip = (await screen.findByText('Fields:')).parentElement!;
    expect(within(strip).getByText('{salutation}')).toBeInTheDocument();
  });

  it('deletes the selected box with the keyboard and brings it back with undo', async () => {
    serve([textBox]);
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(document.querySelector('[data-annotation="field"]')!);
    fireEvent.keyDown(document, { key: 'Delete' });
    expect(await screen.findByText('0 fields placed')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'z', metaKey: true });
    expect(await screen.findByText('1 field placed')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'z', metaKey: true, shiftKey: true });
    expect(await screen.findByText('0 fields placed')).toBeInTheDocument();
  });

  it('leaves Backspace alone while the reader is typing inside a text box', async () => {
    serve([textBox]);
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(document.querySelector('[data-annotation="field"]')!);
    const editable = await waitFor(() => document.querySelector<HTMLElement>('[contenteditable="true"]')!);
    fireEvent.keyDown(editable, { key: 'Backspace' });

    expect(screen.getByText('1 field placed')).toBeInTheDocument();
  });

  it('trims a box an older save left running off the page so the layout saves again', async () => {
    serve([{ ...textBox, xPercent: 70, yPercent: 90, widthPercent: 95, heightPercent: 30 }]);
    renderEditor();
    await screen.findByText('1 field placed');

    const save = await saveLayout();
    expect((save.body as any).placements[0]).toMatchObject({ xPercent: 70, yPercent: 90, widthPercent: 30, heightPercent: 10 });
  });

  it('nudges the selected box with the arrow keys and saves the moved position', async () => {
    serve([textBox]);
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(document.querySelector('[data-annotation="field"]')!);
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    fireEvent.keyDown(document, { key: 'ArrowDown', shiftKey: true });

    const save = await saveLayout();
    expect((save.body as any).placements[0]).toMatchObject({ xPercent: 10.25, yPercent: 11 });
  });

  it('duplicates the selected box beside the original', async () => {
    serve([textBox]);
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(document.querySelector('[data-annotation="field"]')!);
    fireEvent.keyDown(document, { key: 'd', metaKey: true });

    expect(await screen.findByText('2 fields placed')).toBeInTheDocument();
    const save = await saveLayout();
    const [original, copy] = (save.body as any).placements;
    expect(copy).toMatchObject({ xPercent: original.xPercent + 1, yPercent: original.yPercent + 1, richText });
  });

  it('shows the size a box really renders at when the chosen size does not fit', async () => {
    // A 6% tall box on a 792pt page is 47.5pt: a 72pt line cannot fit, so
    // the text shrinks and the toolbar has to say so.
    serve([{ ...textBox, fontSize: 72 }]);
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(document.querySelector('[data-annotation="field"]')!);

    const note = await screen.findByTestId('fitted-size');
    expect(note).toHaveTextContent(/fits at \d+/);
    expect(Number(note.textContent!.replace(/\D/g, ''))).toBeLessThan(72);
  });
});

const PAGE_RECT = { x: 0, y: 0, left: 0, top: 0, width: 612, height: 792, right: 612, bottom: 792, toJSON: () => ({}) };

function boxes() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-annotation="field"]'));
}

function puts() {
  return api.callsTo(`/templates/${TEMPLATE}/placements`).filter((c) => c.method === 'PUT');
}

// Selects the box and drags its corner handle to a viewport point. The fake
// page sits at the viewport origin, so a client coordinate is a page pixel.
function resizeTo(box: HTMLElement, clientX: number, clientY: number) {
  fireEvent.click(box);
  const handle = box.querySelector<HTMLElement>('.cursor-se-resize')!;
  fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX, clientY });
  fireEvent.pointerUp(window, { pointerId: 1 });
}

describe('TemplateOverlayEditor geometry', () => {
  let restorePointerEvents: () => void;
  beforeAll(() => { restorePointerEvents = installPointerEvents(); });
  afterAll(() => restorePointerEvents());

  it('stops a resize at the right and bottom page edges, keeping the box where it was', async () => {
    serve([{ ...textBox, xPercent: 70, yPercent: 80, widthPercent: 20, heightPercent: 6 }]);
    renderEditor();
    await screen.findByText('1 field placed');

    resizeTo(boxes()[0], 5000, 5000);

    const saved = (await saveLayout()).body as any;
    const box = saved.placements[0];
    expect(box).toMatchObject({ xPercent: 70, yPercent: 80 });
    expect(box.widthPercent).toBeCloseTo(30, 6);
    expect(box.heightPercent).toBeCloseTo(20, 6);
    expect(box.xPercent + box.widthPercent).toBeLessThanOrEqual(100 + 1e-6);
    expect(box.yPercent + box.heightPercent).toBeLessThanOrEqual(100 + 1e-6);
  });
});

describe('TemplateOverlayEditor save guard', () => {
  it('keeps the save dialog open when Escape is pressed while the save is in flight', async () => {
    serve([textBox], { put: (call: any) => ({ body: saveResponse(call), delayMs: 300 }) });
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(await screen.findByRole('button', { name: /save layout/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(puts()).toHaveLength(1));

    fireEvent.keyDown(document, { key: 'Escape' });
    // Past the dialog's 100ms close transition, so a close would have unmounted it.
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The save then finishes and closes it the normal way.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('refuses to save an empty text box, selects it and says why', async () => {
    serve([textBox, { ...textBox, id: 'pl-2', yPercent: 40, textContent: '', richText: null, fieldName: 'Text' }]);
    renderEditor();
    await screen.findByText('2 fields placed');

    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/text box is empty/i);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const [first, second] = boxes();
    expect(second.className).toContain('z-20');
    expect(first.className).not.toContain('z-20');
    expect(puts()).toHaveLength(0);
  });

  it('treats a text box holding only a field chip as filled', async () => {
    const chipOnly = [{ bullet: false, runs: [{ text: '{salutation}', fieldName: 'salutation', bold: false, italic: false, color: '#000000' }] }];
    serve([{ ...textBox, textContent: '   ', richText: chipOnly }]);
    renderEditor();
    await screen.findByText('1 field placed');

    const save = await saveLayout();
    expect((save.body as any).placements[0].richText).toEqual(chipOnly);
  });

  it('saves a long single-run text box as runs the server accepts, with the text unchanged', async () => {
    const long = `${'a'.repeat(499)}\u{1F600}${'b'.repeat(700)}`;
    serve([{ ...textBox, textContent: long, richText: [{ bullet: false, runs: [{ text: long, bold: true, italic: false, color: '#1a56db' }] }] }]);
    renderEditor();
    await screen.findByText('1 field placed');

    const save = await saveLayout();

    const runs = (save.body as any).placements[0].richText[0].runs;
    expect(runs.length).toBeGreaterThan(1);
    for (const run of runs) {
      expect(run.text.length).toBeLessThanOrEqual(500);
      expect(run).toMatchObject({ bold: true, italic: false, color: '#1a56db' });
    }
    // Joined back, nothing is lost, and the emoji's two halves stay together.
    expect(runs.map((run: any) => run.text).join('')).toBe(long);
  });

  it('refuses to save a text box longer than the server accepts', async () => {
    const long = 'a'.repeat(2001);
    serve([{ ...textBox, textContent: long, richText: [{ bullet: false, runs: [{ text: long, bold: false, italic: false, color: '#000000' }] }] }]);
    renderEditor();
    await screen.findByText('1 field placed');

    fireEvent.click(screen.getByRole('button', { name: /save layout/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/2,000 characters/);
    expect(boxes()[0].className).toContain('z-20');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });
});

describe('TemplateOverlayEditor undo history', () => {
  let restorePointerEvents: () => void;
  beforeAll(() => { restorePointerEvents = installPointerEvents(); });
  afterAll(() => restorePointerEvents());

  async function deleteThenUndo() {
    serve([textBox]);
    renderEditor();
    await screen.findByText('1 field placed');
    fireEvent.click(boxes()[0]);
    fireEvent.keyDown(document, { key: 'Delete' });
    await screen.findByText('0 fields placed');
    fireEvent.keyDown(document, { key: 'z', metaKey: true });
    await screen.findByText('1 field placed');
  }

  it('keeps redo available after a click on a box that does not move it', async () => {
    await deleteThenUndo();

    const box = boxes()[0];
    fireEvent.pointerDown(box, { pointerId: 1, isPrimary: true, clientX: 70, clientY: 90 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.click(box);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.keyDown(document, { key: 'z', metaKey: true, shiftKey: true });
    expect(await screen.findByText('0 fields placed')).toBeInTheDocument();
  });

  it('keeps redo available after pressing the resize handle without dragging it', async () => {
    await deleteThenUndo();

    const box = boxes()[0];
    fireEvent.click(box);
    const handle = box.querySelector<HTMLElement>('.cursor-se-resize')!;
    fireEvent.pointerDown(handle, { pointerId: 1, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerUp(window, { pointerId: 1 });
    fireEvent.keyDown(document.body, { key: 'Escape' });

    fireEvent.keyDown(document.body, { key: 'z', metaKey: true, shiftKey: true });
    expect(await screen.findByText('0 fields placed')).toBeInTheDocument();
  });

  it('still records one undo step for a drag that moves the box', async () => {
    const rect = jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.hasAttribute('data-pdf-page') ? PAGE_RECT : { ...PAGE_RECT, width: 0, height: 0, right: 0, bottom: 0 }) as DOMRect;
    });
    try {
      serve([textBox]);
      renderEditor();
      await screen.findByText('1 field placed');

      const box = boxes()[0];
      fireEvent.pointerDown(box, { pointerId: 1, isPrimary: true, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 110, clientY: 10 });
      fireEvent.pointerMove(window, { pointerId: 1, clientX: 160, clientY: 10 });
      fireEvent.pointerUp(window, { pointerId: 1 });
      await waitFor(() => expect(boxes()[0].style.left).toBe('150px'));

      fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
      await waitFor(() => expect(boxes()[0].style.left).toBe(`${0.1 * 612}px`));
    } finally {
      rect.mockRestore();
    }
  });
});

describe('TemplateOverlayEditor load failure', () => {
  it('offers Back and a retry when the template cannot be loaded', async () => {
    serve([textBox], {
      template: sequence({ status: 500, body: { error: 'Database unavailable' } }, templateBody),
    });
    const onBack = jest.fn();
    renderWithProviders(
      <TemplateOverlayEditor lawFirmId={FIRM} templateId={TEMPLATE} onSaved={jest.fn()} onBack={onBack} />,
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('1 field placed')).toBeInTheDocument();
    expect(api.callsTo(`/templates/${TEMPLATE}`).filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('offers Back when the overlay document itself cannot be fetched', async () => {
    serve([textBox], { pdf: { status: 404, text: 'missing', headers: { 'content-type': 'text/plain' } } });
    const onBack = jest.fn();
    renderWithProviders(
      <TemplateOverlayEditor lawFirmId={FIRM} templateId={TEMPLATE} onSaved={jest.fn()} onBack={onBack} />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/failed to load the overlay document/i);
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
