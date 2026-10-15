import type {
  TemplateFieldPlacementType,
  TemplatePlacementFontFamily,
  TemplatePlacementTextAlign,
  TemplateRichTextBlock,
} from "@/types/template";

/** A placement as the overlay editor holds it while authoring: an existing
 *  saved placement keeps its server `id`; a box drawn this session gets a
 *  local temp id until the next successful save replaces it with the real
 *  one, the same "temp id until saved" convention `SignatureFieldPlacer`
 *  uses for its own field list. */
export interface PlacementDraft {
  id: string;
  fieldName: string;
  fieldType: TemplateFieldPlacementType;
  page: number;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  repeaterName: string | null;
  repeaterRowIndex: number | null;
  sortOrder: number;
  /** Plain values for text/date fields. Textboxes use richText exclusively. */
  textContent: string | null;
  /** A textbox's styled paragraph blocks. Null for other placement types. */
  richText: TemplateRichTextBlock[] | null;
  /** GCS object path + mime type for an 'image' placement. Null for other types. */
  imageObjectPath: string | null;
  imageMimeType: string | null;
  /** Signed URL to render the uploaded image on the canvas. Client-only,
   *  never sent back to the server. */
  imagePreviewUrl: string | null;
  fontSize: number | null;
  fontFamily: TemplatePlacementFontFamily;
  bold: boolean;
  italic: boolean;
  color: string;
  textAlign: TemplatePlacementTextAlign;
  bulletList: boolean;
}

/** The sizes the toolbar offers. Denser than the signing tools' list around
 *  body-text sizes, because a box is usually set to match the document's own
 *  print, which is 9, 10, 11 or 12 point far more often than it is 8 or 14. */
export const OVERLAY_FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72] as const;

/** The automatic maximum for a box left on "Auto": 55% of its height, kept
 *  between 10pt and 18pt. One rule for every field type, the editable view,
 *  the preview and the PDF stamp (overlayFill.service.ts's autoFontSize),
 *  so a box never renders at one size and prints at another. */
export function autoPlacementFontSize(boxHeightPt: number) {
  return Math.max(10, Math.min(boxHeightPt * 0.55, 18));
}

/** A freshly-placed box's style before the user changes anything. */
export const DEFAULT_PLACEMENT_STYLE = {
  fontSize: 14 as number | null,
  fontFamily: "times" as TemplatePlacementFontFamily,
  bold: false,
  italic: false,
  color: "#000000",
  textAlign: "left" as TemplatePlacementTextAlign,
  bulletList: false,
};

/** A repeater's non-geometry settings. `anchorPage`/`anchorYPercent` are not
 *  kept here: they are derived live from the repeater's column placements
 *  (the topmost point of its authored row) so moving a column can never
 *  desync the anchor from where the row actually is. */
export interface RepeaterDraft {
  name: string;
  rowHeightPercent: number;
  rowCount: number;
}

export interface PlacementState {
  placements: PlacementDraft[];
  selectedId: string | null;
}

export type PlacementStyleDraft = Pick<PlacementDraft, "fontSize" | "fontFamily" | "bold" | "italic" | "color" | "textAlign" | "bulletList">;

export type PlacementAction =
  | { type: "REPLACE_ALL"; placements: PlacementDraft[] }
  | { type: "ADD"; placement: PlacementDraft }
  | { type: "MOVE"; id: string; xPercent: number; yPercent: number }
  | { type: "MOVE_TO_PAGE"; id: string; page: number; xPercent: number; yPercent: number }
  | { type: "RESIZE"; id: string; widthPercent: number; heightPercent: number }
  | { type: "SET_TYPE"; id: string; fieldType: TemplateFieldPlacementType }
  | { type: "SET_STYLE"; id: string; style: Partial<PlacementStyleDraft> }
  | { type: "SET_RICH_TEXT"; id: string; richText: TemplateRichTextBlock[] }
  | { type: "SET_IMAGE"; id: string; imageObjectPath: string; imageMimeType: string; imagePreviewUrl: string | null }
  | { type: "DELETE"; id: string }
  | { type: "DELETE_REPEATER"; repeaterName: string }
  | { type: "SELECT"; id: string | null };

export function placementReducer(state: PlacementState, action: PlacementAction): PlacementState {
  switch (action.type) {
    case "REPLACE_ALL":
      return { placements: action.placements, selectedId: null };
    case "ADD":
      // A newly placed box is left unselected, matching SignatureFieldPlacer's
      // ADD: placing one clears any existing selection rather than jumping the
      // canvas's attention to it.
      return { ...state, placements: [...state.placements, action.placement], selectedId: null };
    case "MOVE":
      return {
        ...state,
        placements: state.placements.map((p) =>
          p.id === action.id ? { ...p, xPercent: action.xPercent, yPercent: action.yPercent } : p
        ),
      };
    case "MOVE_TO_PAGE":
      return {
        ...state,
        placements: state.placements.map((p) =>
          p.id === action.id
            ? { ...p, page: action.page, xPercent: action.xPercent, yPercent: action.yPercent }
            : p
        ),
      };
    case "RESIZE":
      return {
        ...state,
        placements: state.placements.map((p) =>
          p.id === action.id ? { ...p, widthPercent: action.widthPercent, heightPercent: action.heightPercent } : p
        ),
      };
    case "SET_TYPE":
      return {
        ...state,
        placements: state.placements.map((p) =>
          p.id === action.id ? { ...p, fieldType: action.fieldType } : p
        ),
      };
    case "SET_STYLE":
      return {
        ...state,
        placements: state.placements.map((p) =>
          p.id === action.id ? { ...p, ...action.style } : p
        ),
      };
    case "SET_RICH_TEXT":
      return {
        ...state,
        placements: state.placements.map((p) => {
          if (p.id !== action.id) return p;
          const textContent = richTextPlainLabel(action.richText);
          // A standalone text box has no field-name UI of its own (there's
          // no merge-field picker to type one into), so it's derived from
          // the content itself: shown only in this box's own selected-
          // toolbar label, never in the "Fields:" strip (text boxes are
          // excluded from that server-side). A repeater column's name is
          // fixed at creation instead (named via PlaceholderModal when
          // drawn), so it must NOT silently rename itself as the user types.
          const fieldName = p.repeaterName ? p.fieldName : (textContent.trim() ? textContent.trim().slice(0, 40) : "Text");
          return { ...p, richText: action.richText, textContent: null, bulletList: false, fieldName };
        }),
      };
    case "SET_IMAGE":
      return {
        ...state,
        placements: state.placements.map((p) =>
          p.id === action.id
            ? { ...p, imageObjectPath: action.imageObjectPath, imageMimeType: action.imageMimeType, imagePreviewUrl: action.imagePreviewUrl }
            : p
        ),
      };
    case "DELETE":
      return {
        ...state,
        placements: state.placements.filter((p) => p.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      };
    case "DELETE_REPEATER":
      return {
        ...state,
        placements: state.placements.filter((p) => p.repeaterName !== action.repeaterName),
        selectedId: null,
      };
    case "SELECT":
      return { ...state, selectedId: action.id };
    default:
      return state;
  }
}

let placementCounter = 0;
export function genPlacementId() {
  return `placement_${Date.now()}_${++placementCounter}`;
}

/** How far a keyboard nudge moves a box, as a percent of the page: a step
 *  small enough to line a box up with a printed rule, and a larger one with
 *  Shift for crossing the page. */
export const NUDGE_STEP_PERCENT = 0.25;
export const NUDGE_STEP_LARGE_PERCENT = 1;

export function nudgePlacement(
  placement: PlacementDraft,
  dx: number,
  dy: number,
): { xPercent: number; yPercent: number } {
  return {
    xPercent: Math.max(0, Math.min(100 - placement.widthPercent, placement.xPercent + dx)),
    yPercent: Math.max(0, Math.min(100 - placement.heightPercent, placement.yPercent + dy)),
  };
}

/** A copy of a standalone box, offset a little so it does not hide the
 *  original, with a fresh id. A repeater column is deliberately not copied
 *  here: two columns of one repeater with the same name resolve to the same
 *  value, so a copy would need a new name the caller has to ask for. */
export function duplicatePlacement(placement: PlacementDraft, sortOrder: number): PlacementDraft {
  const box = clampPlacementBox(
    placement.xPercent + NUDGE_STEP_LARGE_PERCENT,
    placement.yPercent + NUDGE_STEP_LARGE_PERCENT,
    placement.widthPercent,
    placement.heightPercent,
  );
  return { ...placement, ...box, id: genPlacementId(), sortOrder };
}

export function clampPlacementBox(
  xPercent: number,
  yPercent: number,
  widthPercent: number,
  heightPercent: number,
) {
  const safeWidth = Math.max(2, Math.min(95, widthPercent));
  const safeHeight = Math.max(2, Math.min(95, heightPercent));
  return {
    xPercent: Math.max(0, Math.min(xPercent, 100 - safeWidth)),
    yPercent: Math.max(0, Math.min(yPercent, 100 - safeHeight)),
    widthPercent: safeWidth,
    heightPercent: safeHeight,
  };
}

/** A box's size while its corner handle is dragged. The top-left corner
 *  stays where it is, so the room left is the distance from it to the right
 *  and bottom page edges; the server refuses a box that runs past either.
 *  The 2% floor keeps a box big enough to grab again. */
export function resizedPlacementSize(
  xPercent: number,
  yPercent: number,
  widthPercent: number,
  heightPercent: number,
) {
  return {
    widthPercent: Math.min(100 - xPercent, Math.max(2, widthPercent)),
    heightPercent: Math.min(100 - yPercent, Math.max(2, heightPercent)),
  };
}

/** One axis of fitPlacementToPage: the part of the box off either end of
 *  the page is cut away, and a box wholly past the far edge is pulled back
 *  to the minimum 2% so it can be grabbed again. */
function fitAxisToPage(start: number, size: number) {
  let nextStart = start;
  let nextSize = size;
  if (nextStart < 0) {
    nextSize += nextStart;
    nextStart = 0;
  }
  nextStart = Math.min(nextStart, 98);
  nextSize = Math.max(2, Math.min(nextSize, 100 - nextStart));
  return { start: nextStart, size: nextSize };
}

/** A saved box trimmed to the page. Layouts saved before the server refused
 *  off-page boxes can still hold one, and saving it unchanged would now
 *  fail. Only the off-page part is cut, which never printed, so the part a
 *  filled document shows stays where it was. A box that already fits comes
 *  back as the same object. */
export function fitPlacementToPage(placement: PlacementDraft): PlacementDraft {
  const x = fitAxisToPage(placement.xPercent, placement.widthPercent);
  const y = fitAxisToPage(placement.yPercent, placement.heightPercent);
  if (
    x.start === placement.xPercent
    && x.size === placement.widthPercent
    && y.start === placement.yPercent
    && y.size === placement.heightPercent
  ) {
    return placement;
  }
  return { ...placement, xPercent: x.start, widthPercent: x.size, yPercent: y.start, heightPercent: y.size };
}

/** The longest text the server accepts in one rich text run. */
export const RICH_TEXT_RUN_MAX_CHARS = 500;

/** Rich text with every run longer than the server's per-run limit cut into
 *  consecutive runs of the same style, so a long typed paragraph saves
 *  instead of failing the whole layout. A cut never lands between the two
 *  halves of a surrogate pair. Field chips are short labels and never cut. */
export function splitLongRichTextRuns(blocks: TemplateRichTextBlock[]): TemplateRichTextBlock[] {
  return blocks.map((block) => ({
    ...block,
    runs: block.runs.flatMap((run) => {
      if (run.fieldName || run.text.length <= RICH_TEXT_RUN_MAX_CHARS) return [run];
      const pieces: typeof block.runs = [];
      let rest = run.text;
      while (rest.length > RICH_TEXT_RUN_MAX_CHARS) {
        let cut = RICH_TEXT_RUN_MAX_CHARS;
        const code = rest.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
        pieces.push({ ...run, text: rest.slice(0, cut) });
        rest = rest.slice(cut);
      }
      if (rest) pieces.push({ ...run, text: rest });
      return pieces;
    }),
  }));
}

export function defaultPlacementSize(fieldType: TemplateFieldPlacementType) {
  switch (fieldType) {
    case "checkbox":
      return { widthPercent: 4, heightPercent: 3 };
    case "date":
      return { widthPercent: 16, heightPercent: 4 };
    case "textbox":
      return { widthPercent: 30, heightPercent: 6 };
    case "image":
      return { widthPercent: 20, heightPercent: 12 };
    default:
      return { widthPercent: 22, heightPercent: 4 };
  }
}

/** Text used for authoring labels and length checks, never persisted as a second textbox value. */
export function richTextPlainLabel(blocks: TemplateRichTextBlock[]): string {
  return blocks.map((block) => block.runs.map((run) => run.fieldName ? `{${run.fieldName}}` : run.text).join("")).join("\n");
}

/** Every new textbox starts with a styled empty paragraph ready for input. */
export function initialTextboxContent(style: Pick<PlacementDraft, "bold" | "italic" | "color">): TemplateRichTextBlock[] {
  return [{ bullet: false, runs: [{ text: "", bold: style.bold, italic: style.italic, color: style.color }] }];
}

/** The repeater's anchor, derived from its column placements rather than
 *  stored: the page they sit on and the topmost edge among them. Null when
 *  the repeater currently has no columns (mid-authoring, before the first
 *  box is drawn). */
export function repeaterAnchor(placements: PlacementDraft[], repeaterName: string) {
  const columns = placements.filter((p) => p.repeaterName === repeaterName);
  if (columns.length === 0) return null;
  return {
    anchorPage: columns[0].page,
    anchorYPercent: Math.min(...columns.map((c) => c.yPercent)),
  };
}
