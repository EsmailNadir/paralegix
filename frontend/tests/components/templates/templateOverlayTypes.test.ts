import {
  autoPlacementFontSize,
  DEFAULT_PLACEMENT_STYLE,
  duplicatePlacement,
  fitPlacementToPage,
  nudgePlacement,
  resizedPlacementSize,
  OVERLAY_FONT_SIZES,
  placementReducer,
  type PlacementDraft,
} from '@/components/templatesComp/templateOverlayTypes';

function draft(overrides: Partial<PlacementDraft> = {}): PlacementDraft {
  return {
    id: 'p1',
    fieldName: 'clientName',
    fieldType: 'text',
    page: 1,
    xPercent: 10,
    yPercent: 10,
    widthPercent: 20,
    heightPercent: 4,
    repeaterName: null,
    repeaterRowIndex: null,
    sortOrder: 0,
    textContent: null,
    richText: null,
    imageObjectPath: null,
    imageMimeType: null,
    imagePreviewUrl: null,
    ...DEFAULT_PLACEMENT_STYLE,
    ...overrides,
  };
}

describe('autoPlacementFontSize', () => {
  it('is 55% of the box height between 10pt and 18pt', () => {
    expect(autoPlacementFontSize(20)).toBe(11);
    expect(autoPlacementFontSize(10)).toBe(10);
    expect(autoPlacementFontSize(100)).toBe(18);
  });
});

describe('OVERLAY_FONT_SIZES', () => {
  it('offers the body-text sizes a document is usually set in', () => {
    // A readout of "11 pt" that the size control cannot be set to is a
    // readout the reader cannot act on.
    expect(OVERLAY_FONT_SIZES).toEqual(expect.arrayContaining([9, 10, 11, 12, 13]));
  });
});

describe('nudgePlacement', () => {
  it('moves by the step and stays on the page', () => {
    expect(nudgePlacement(draft(), 0.25, -0.25)).toEqual({ xPercent: 10.25, yPercent: 9.75 });
    expect(nudgePlacement(draft({ xPercent: 79.9 }), 1, 0)).toEqual({ xPercent: 80, yPercent: 10 });
    expect(nudgePlacement(draft({ yPercent: 0.1 }), 0, -1)).toEqual({ xPercent: 10, yPercent: 0 });
  });
});

describe('duplicatePlacement', () => {
  it('copies the box under a new id, offset so it does not hide the original', () => {
    const copy = duplicatePlacement(draft(), 7);
    expect(copy.id).not.toBe('p1');
    expect(copy).toMatchObject({ fieldName: 'clientName', xPercent: 11, yPercent: 11, widthPercent: 20, heightPercent: 4, sortOrder: 7 });
  });
});

describe('placementReducer SET_RICH_TEXT', () => {
  const richText = [
    { bullet: true, runs: [{ text: 'Dear ', bold: false, italic: false, color: '#000000' }, { text: '{salutation}', fieldName: 'salutation', bold: true, italic: false, color: '#000000' }] },
  ];

  it('keeps rich runs without a flat textbox mirror', () => {
    const state = placementReducer(
      { placements: [draft({ fieldType: 'textbox', fieldName: 'Text' })], selectedId: null },
      { type: 'SET_RICH_TEXT', id: 'p1', richText },
    );
    expect(state.placements[0].richText).toEqual(richText);
    expect(state.placements[0].textContent).toBeNull();
    expect(state.placements[0].bulletList).toBe(false);
    // A standalone text box is named after its content, for its own toolbar label.
    expect(state.placements[0].fieldName).toBe('Dear {salutation}');
  });

  it('never renames a repeater column from its content', () => {
    const state = placementReducer(
      { placements: [draft({ fieldType: 'textbox', fieldName: 'caption', repeaterName: 'exhibits', repeaterRowIndex: 0 })], selectedId: null },
      { type: 'SET_RICH_TEXT', id: 'p1', richText },
    );
    expect(state.placements[0].fieldName).toBe('caption');
  });
});

describe('resizedPlacementSize', () => {
  it('caps the size at the page edges measured from the fixed top-left corner', () => {
    expect(resizedPlacementSize(70, 80, 93, 40)).toEqual({ widthPercent: 30, heightPercent: 20 });
  });

  it('lets a box at the origin grow to the full page', () => {
    expect(resizedPlacementSize(0, 0, 150, 150)).toEqual({ widthPercent: 100, heightPercent: 100 });
  });

  it('keeps the 2% minimum when dragged back past the corner', () => {
    expect(resizedPlacementSize(10, 10, -5, 0.5)).toEqual({ widthPercent: 2, heightPercent: 2 });
  });

  it('leaves a size that already fits untouched', () => {
    expect(resizedPlacementSize(10, 10, 25.5, 4.25)).toEqual({ widthPercent: 25.5, heightPercent: 4.25 });
  });
});

describe('fitPlacementToPage', () => {
  it('trims a box saved past the right and bottom edges back to the page', () => {
    expect(fitPlacementToPage(draft({ xPercent: 70, yPercent: 90, widthPercent: 95, heightPercent: 30 }))).toMatchObject({
      xPercent: 70,
      yPercent: 90,
      widthPercent: 30,
      heightPercent: 10,
    });
  });

  it('trims the part of a box above or left of the page instead of moving it', () => {
    expect(fitPlacementToPage(draft({ xPercent: -5, yPercent: -2, widthPercent: 20, heightPercent: 6 }))).toMatchObject({
      xPercent: 0,
      yPercent: 0,
      widthPercent: 15,
      heightPercent: 4,
    });
  });

  it('pulls a box saved entirely off the page back onto it at the minimum size', () => {
    expect(fitPlacementToPage(draft({ xPercent: 120, yPercent: 10, widthPercent: 20, heightPercent: 4 }))).toMatchObject({
      xPercent: 98,
      widthPercent: 2,
    });
  });

  it('returns a box that already fits as the same object', () => {
    const fitting = draft({ xPercent: 80, yPercent: 96, widthPercent: 20, heightPercent: 4 });
    expect(fitPlacementToPage(fitting)).toBe(fitting);
  });
});
