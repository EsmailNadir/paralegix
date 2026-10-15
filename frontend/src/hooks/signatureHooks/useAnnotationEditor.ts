'use client';

import { useReducer, useCallback, useRef, useState, useEffect } from 'react';
import { stampAnnotationsOntoPdf, downloadPdf } from '@/components/signaturesComp/pdfStamper';
import {
  getActiveEditorInfo,
  mapCssToFontValue,
  foreColorToHex,
  applyFontSizeToSelection,
  applyFontFamilyToSelection,
  applyColorToSelection,
} from '@/components/signaturesComp/textFormatting';
import type {
  AnnotatorState,
  AnnotatorAction,
  Annotation,
  TextAnnotationData,
  SignatureAnnotationData,
  SignatureStyle,
} from '@/types/signature';
import {
  DEFAULT_TEXT_ANNOTATION,
  DEFAULT_SIGNATURE_SIZE,
  FONT_FAMILIES,
  DEFAULT_SIGNATURE_STYLE,
  resolveSignatureStyle,
} from '@/types/signature';
import signaturesService from '@/services/signatures.service';
import { getErrorMessage } from '@/lib/utils/apiErrors';

// --- Reducer ---

const initialState: AnnotatorState = {
  fileUrl: null,
  fileName: null,
  pdfBytes: null,
  currentPage: 1,
  totalPages: 0,
  scale: 1,
  mode: 'text',
  annotations: [],
  selectedAnnotationId: null,
  defaultFontFamily: 'Helvetica',
  defaultFontSize: 16,
  defaultBold: false,
  defaultItalic: false,
  defaultColor: '#000000',
  defaultSignatureStyle: DEFAULT_SIGNATURE_STYLE,
  history: [],
  future: [],
  signatureModalOpen: false,
  signaturePlacement: null,
  isDownloading: false,
  isConverting: false,
  error: null,
};

function clampPercent(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampAnnotationPlacement(
  xPercent: number,
  yPercent: number,
  widthPercent: number,
  heightPercent: number,
) {
  const safeWidth = clampPercent(widthPercent, 1, 100);
  const safeHeight = clampPercent(heightPercent, 1, 100);

  return {
    xPercent: clampPercent(xPercent, 0, Math.max(0, 100 - safeWidth)),
    yPercent: clampPercent(yPercent, 0, Math.max(0, 100 - safeHeight)),
    widthPercent: safeWidth,
    heightPercent: safeHeight,
  };
}

function pushHistory(state: AnnotatorState): AnnotatorState {
  return {
    ...state,
    history: [...state.history.slice(-49), state.annotations],
    future: [],
  };
}

function annotatorReducer(state: AnnotatorState, action: AnnotatorAction): AnnotatorState {
  switch (action.type) {
    case 'SET_FILE':
      return {
        ...initialState,
        fileUrl: action.fileUrl,
        fileName: action.fileName,
        pdfBytes: action.pdfBytes ?? null,
      };

    case 'SET_TOTAL_PAGES':
      return { ...state, totalPages: action.totalPages };

    case 'SET_PAGE':
      return { ...state, currentPage: action.page, selectedAnnotationId: null };

    case 'SET_SCALE':
      return { ...state, scale: action.scale };

    case 'SET_MODE':
      return { ...state, mode: action.mode, selectedAnnotationId: null };

    case 'ADD_ANNOTATION': {
      const s = pushHistory(state);
      return {
        ...s,
        annotations: [...s.annotations, action.annotation],
        selectedAnnotationId: action.annotation.id,
      };
    }

    case 'UPDATE_ANNOTATION': {
      const s = pushHistory(state);
      return {
        ...s,
        annotations: s.annotations.map((a) =>
          a.id === action.id ? ({ ...a, ...action.changes } as Annotation) : a
        ),
      };
    }

    case 'SET_ANNOTATION_TEXT':
      return {
        ...state,
        annotations: state.annotations.map((a) =>
          a.id === action.id ? ({ ...a, text: action.text } as Annotation) : a
        ),
      };

    case 'DELETE_ANNOTATION': {
      const s = pushHistory(state);
      return {
        ...s,
        annotations: s.annotations.filter((a) => a.id !== action.id),
        selectedAnnotationId:
          s.selectedAnnotationId === action.id ? null : s.selectedAnnotationId,
      };
    }

    case 'SELECT_ANNOTATION':
      return { ...state, selectedAnnotationId: action.id };

    case 'MOVE_ANNOTATION': {
      const s = pushHistory(state);
      return {
        ...s,
        annotations: s.annotations.map((a) =>
          a.id === action.id ? { ...a, xPercent: action.xPercent, yPercent: action.yPercent } : a
        ),
      };
    }

    case 'RESIZE_ANNOTATION': {
      const s = pushHistory(state);
      return {
        ...s,
        annotations: s.annotations.map((a) =>
          a.id === action.id
            ? { ...a, widthPercent: action.widthPercent, heightPercent: action.heightPercent }
            : a
        ),
      };
    }

    case 'SET_DEFAULT_STYLE':
      return {
        ...state,
        defaultFontFamily: action.fontFamily ?? state.defaultFontFamily,
        defaultFontSize: action.fontSize ?? state.defaultFontSize,
        defaultBold: action.isBold ?? state.defaultBold,
        defaultItalic: action.isItalic ?? state.defaultItalic,
        defaultColor: action.color ?? state.defaultColor,
      };

    case 'SET_DEFAULT_SIGNATURE_STYLE':
      return {
        ...state,
        defaultSignatureStyle: action.style,
      };

    case 'OPEN_SIGNATURE_MODAL':
      return {
        ...state,
        signatureModalOpen: true,
        signaturePlacement: { page: action.page, xPercent: action.xPercent, yPercent: action.yPercent },
      };

    case 'CLOSE_SIGNATURE_MODAL':
      return { ...state, signatureModalOpen: false, signaturePlacement: null };

    case 'UNDO': {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      return {
        ...state,
        annotations: prev,
        history: state.history.slice(0, -1),
        future: [state.annotations, ...state.future],
        selectedAnnotationId: null,
      };
    }

    case 'REDO': {
      if (state.future.length === 0) return state;
      const next = state.future[0];
      return {
        ...state,
        annotations: next,
        history: [...state.history, state.annotations],
        future: state.future.slice(1),
        selectedAnnotationId: null,
      };
    }

    case 'SET_DOWNLOADING':
      return { ...state, isDownloading: action.isDownloading };

    case 'SET_CONVERTING':
      return { ...state, isConverting: action.isConverting };

    case 'SET_ERROR':
      return { ...state, error: action.error };

    case 'RESET':
      return initialState;

    default:
      return state;
  }
}

// --- Helpers ---

let idCounter = 0;
function genId() {
  return `ann_${Date.now()}_${++idCounter}`;
}

// --- Hook ---

/**
 * The most the annotator will stamp. The annotator draws with pdf-lib, which
 * parses the whole document into its own object graph, several times the file
 * size, in the tab. Field-driven signing sends values and lets the API append;
 * this path cannot, so it is capped where the field path is not.
 */
export const ANNOTATOR_MAX_BYTES = 50 * 1024 * 1024;

/** The refusal shown when a document is over `ANNOTATOR_MAX_BYTES`. */
export const ANNOTATOR_TOO_LARGE_MESSAGE = 'This document is too large to sign in the browser.';

export interface UseAnnotationEditorOptions {
  /** Pre-loaded file (skips the upload zone) */
  initialFile?: { url: string; name: string; sizeBytes?: number; bytes?: Uint8Array };
  /** Called when user downloads, receives stamped PDF bytes + filename */
  onSave?: (pdfBytes: Uint8Array, fileName: string) => void;
}

export function useAnnotationEditor(options?: UseAnnotationEditorOptions) {
  const onSave = options?.onSave;
  const [state, dispatch] = useReducer(annotatorReducer, initialState);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  const savedSelectionRef = useRef<{ range: Range; editorEl: HTMLDivElement } | null>(null);
  const initializedRef = useRef(false);

  // Track the current selection's formatting for the toolbar display
  const [selectionFormat, setSelectionFormat] = useState({
    isBold: false,
    isItalic: false,
    fontFamily: 'Helvetica',
    fontSize: 16,
    color: '#000000',
    isInEditor: false,
  });

  // Load initial file if provided
  useEffect(() => {
    if (options?.initialFile && !initializedRef.current) {
      initializedRef.current = true;
      pdfBytesRef.current = options.initialFile.bytes ?? null;
      dispatch({
        type: 'SET_FILE',
        fileUrl: options.initialFile.url,
        fileName: options.initialFile.name,
        pdfBytes: options.initialFile.bytes,
      });
    }
  }, [options?.initialFile]);

  // Selection format tracking
  useEffect(() => {
    let rafId: number;
    const handler = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const info = getActiveEditorInfo();
        if (!info) {
          setSelectionFormat((prev) => (prev.isInEditor ? { ...prev, isInEditor: false } : prev));
          return;
        }

        const isBold = document.queryCommandState('bold');
        const isItalic = document.queryCommandState('italic');
        const fontName = document.queryCommandValue('fontName') || '';
        const fontFamily = fontName ? mapCssToFontValue(fontName) : 'Helvetica';

        let fontSize = 16;
        const sel = window.getSelection();
        if (sel?.anchorNode) {
          const el = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode.parentElement;
          if (el) {
            fontSize = Math.round(parseFloat(window.getComputedStyle(el).fontSize));
          }
        }

        const foreColor = document.queryCommandValue('foreColor') || '';
        const color = foreColor ? foreColorToHex(foreColor) : '#000000';

        setSelectionFormat({ isBold, isItalic, fontFamily, fontSize, color, isInEditor: true });
      });
    };

    document.addEventListener('selectionchange', handler);
    return () => {
      document.removeEventListener('selectionchange', handler);
      cancelAnimationFrame(rafId);
    };
  }, []);

  // --- File handling ---

  const loadPdfFromArrayBuffer = useCallback((buffer: ArrayBuffer, name: string) => {
    const bytes = new Uint8Array(buffer);
    pdfBytesRef.current = bytes;
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    dispatch({ type: 'SET_FILE', fileUrl: url, fileName: name, pdfBytes: bytes });
  }, []);

  const handleFileSelect = useCallback(
    async (file: File) => {
      dispatch({ type: 'SET_ERROR', error: null });

      // Decide by extension, not the client-reported MIME type: drag-and-drop
      // and unregistered OS type mappings routinely report an empty or wrong
      // type, and round-tripping a real PDF through conversion reflows it.
      const hasExtension = /\.[^.]+$/.test(file.name);
      const isPdf = /\.pdf$/i.test(file.name) || (!hasExtension && file.type === 'application/pdf');

      if (isPdf) {
        const buffer = await file.arrayBuffer();
        loadPdfFromArrayBuffer(buffer, file.name);
      } else {
        dispatch({ type: 'SET_CONVERTING', isConverting: true });
        try {
          const converted = await signaturesService.convertDocument(file, 'pdf', file.name);
          const buffer = await converted.arrayBuffer();
          const pdfName = file.name.replace(/\.[^.]+$/, '.pdf');
          loadPdfFromArrayBuffer(buffer, pdfName);
        } catch (err) {
          dispatch({
            type: 'SET_ERROR',
            error: getErrorMessage(err, 'Failed to convert document'),
          });
        } finally {
          dispatch({ type: 'SET_CONVERTING', isConverting: false });
        }
      }
    },
    [loadPdfFromArrayBuffer]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    },
    [handleFileSelect]
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleFileSelect(file);
      e.target.value = '';
    },
    [handleFileSelect]
  );

  // --- Page click (create annotation) ---

  const handlePageClick = useCallback(
    (page: number, xPercent: number, yPercent: number, widthPercent?: number, heightPercent?: number) => {
      if (state.mode === 'text') {
        const placement = clampAnnotationPlacement(
          xPercent,
          yPercent,
          widthPercent ?? DEFAULT_TEXT_ANNOTATION.widthPercent,
          heightPercent ?? DEFAULT_TEXT_ANNOTATION.heightPercent,
        );

        const annotation: TextAnnotationData = {
          ...DEFAULT_TEXT_ANNOTATION,
          id: genId(),
          page,
          xPercent: placement.xPercent,
          yPercent: placement.yPercent,
          widthPercent: placement.widthPercent,
          heightPercent: placement.heightPercent,
          fontFamily: state.defaultFontFamily,
          fontSize: state.defaultFontSize,
          isBold: state.defaultBold,
          isItalic: state.defaultItalic,
          color: state.defaultColor,
        };
        dispatch({ type: 'ADD_ANNOTATION', annotation });
      } else if (state.mode === 'signature') {
        const placement = clampAnnotationPlacement(
          xPercent,
          yPercent,
          DEFAULT_SIGNATURE_SIZE.widthPercent,
          DEFAULT_SIGNATURE_SIZE.heightPercent,
        );

        dispatch({
          type: 'OPEN_SIGNATURE_MODAL',
          page,
          xPercent: placement.xPercent,
          yPercent: placement.yPercent,
        });
      } else {
        dispatch({ type: 'SELECT_ANNOTATION', id: null });
      }
    },
    [state.mode, state.defaultFontFamily, state.defaultFontSize, state.defaultBold, state.defaultItalic, state.defaultColor]
  );

  // --- Signature done ---

  const handleSignatureDone = useCallback(
    (dataUrl: string, style?: SignatureStyle) => {
      if (!state.signaturePlacement) return;
      const signatureStyle = resolveSignatureStyle(style ?? state.defaultSignatureStyle);
      const annotation: SignatureAnnotationData = {
        id: genId(),
        type: 'signature',
        page: state.signaturePlacement.page,
        xPercent: state.signaturePlacement.xPercent,
        yPercent: state.signaturePlacement.yPercent,
        widthPercent: DEFAULT_SIGNATURE_SIZE.widthPercent,
        heightPercent: DEFAULT_SIGNATURE_SIZE.heightPercent,
        dataUrl,
        style: signatureStyle,
      };
      dispatch({ type: 'SET_DEFAULT_SIGNATURE_STYLE', style: signatureStyle });
      dispatch({ type: 'ADD_ANNOTATION', annotation });
      dispatch({ type: 'CLOSE_SIGNATURE_MODAL' });
    },
    [state.signaturePlacement, state.defaultSignatureStyle]
  );

  // --- Download ---

  /**
   * The whole document, read once and kept.
   *
   * Stamping is the one thing here that genuinely needs the whole document, so
   * this is where it is read, on download or submit. The page hands over a url
   * rather than bytes, because the viewer draws from ranges and most sessions
   * never stamp at all. A url with no size up front is held to the same cap
   * here: the response's length is checked before its body is read, and the
   * body again after, for a host that does not send one.
   */
  const ensurePdfBytes = useCallback(async (): Promise<Uint8Array> => {
    if (pdfBytesRef.current) return pdfBytesRef.current;
    if (!state.fileUrl) throw new Error('There is no document to read.');
    const response = await fetch(state.fileUrl);
    if (!response.ok) throw new Error('Failed to read the document');
    const declared = Number(response.headers?.get('content-length'));
    if (Number.isFinite(declared) && declared > ANNOTATOR_MAX_BYTES) {
      throw new Error(ANNOTATOR_TOO_LARGE_MESSAGE);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > ANNOTATOR_MAX_BYTES) throw new Error(ANNOTATOR_TOO_LARGE_MESSAGE);
    pdfBytesRef.current = bytes;
    return bytes;
  }, [state.fileUrl]);

  const handleDownload = useCallback(async (format: string = 'pdf') => {
    if (!state.fileName || (!pdfBytesRef.current && !state.fileUrl)) return;
    dispatch({ type: 'SET_DOWNLOADING', isDownloading: true });
    try {
      const stamped = await stampAnnotationsOntoPdf(await ensurePdfBytes(), state.annotations);

      // If an onSave callback is provided, call it
      if (onSave) {
        onSave(stamped, state.fileName);
      }

      if (format === 'pdf') {
        downloadPdf(stamped, state.fileName);
      } else {
        const blob = await signaturesService.convertDocument(
          new Blob([stamped as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }),
          format,
          'document.pdf',
        );
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        const baseName = state.fileName.replace(/\.[^.]+$/, '');
        link.download = `${baseName}_signed.${format}`;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      dispatch({
        type: 'SET_ERROR',
        error: getErrorMessage(err, 'Failed to generate document'),
      });
    } finally {
      dispatch({ type: 'SET_DOWNLOADING', isDownloading: false });
    }
  }, [onSave, state.annotations, state.fileName, state.fileUrl, ensurePdfBytes]);

  // --- Toolbar formatting ---

  const selectedAnnotation = state.annotations.find((a) => a.id === state.selectedAnnotationId);
  const selectedTextAnnotation =
    selectedAnnotation?.type === 'text' ? (selectedAnnotation as TextAnnotationData) : null;

  const showSelectionFormat = selectionFormat.isInEditor && selectedTextAnnotation;
  const currentFontFamily = showSelectionFormat ? selectionFormat.fontFamily : (selectedTextAnnotation?.fontFamily ?? state.defaultFontFamily);
  const currentFontSize = showSelectionFormat ? selectionFormat.fontSize : (selectedTextAnnotation?.fontSize ?? state.defaultFontSize);
  const currentBold = showSelectionFormat ? selectionFormat.isBold : (selectedTextAnnotation?.isBold ?? state.defaultBold);
  const currentItalic = showSelectionFormat ? selectionFormat.isItalic : (selectedTextAnnotation?.isItalic ?? state.defaultItalic);
  const currentColor = showSelectionFormat ? selectionFormat.color : (selectedTextAnnotation?.color ?? state.defaultColor);
  const currentSignatureStyle = resolveSignatureStyle(state.defaultSignatureStyle);

  const syncActiveEditor = useCallback(() => {
    const info = getActiveEditorInfo();
    if (info) {
      dispatch({ type: 'SET_ANNOTATION_TEXT', id: info.annotationId, text: info.el.innerHTML });
    }
  }, []);

  const saveSelection = useCallback(() => {
    const info = getActiveEditorInfo();
    if (!info) return;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedSelectionRef.current = { range: sel.getRangeAt(0).cloneRange(), editorEl: info.el };
    }
  }, []);

  const restoreSelection = useCallback((): boolean => {
    const saved = savedSelectionRef.current;
    if (!saved) return false;
    saved.editorEl.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(saved.range);
    }
    savedSelectionRef.current = null;
    return true;
  }, []);

  const handleBoldToggle = useCallback(() => {
    const info = getActiveEditorInfo();
    if (info && selectedTextAnnotation) {
      document.execCommand('bold');
      syncActiveEditor();
    } else {
      const newBold = !currentBold;
      dispatch({ type: 'SET_DEFAULT_STYLE', isBold: newBold });
      if (selectedTextAnnotation) {
        dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { isBold: newBold } });
      }
    }
  }, [currentBold, selectedTextAnnotation, syncActiveEditor]);

  const handleItalicToggle = useCallback(() => {
    const info = getActiveEditorInfo();
    if (info && selectedTextAnnotation) {
      document.execCommand('italic');
      syncActiveEditor();
    } else {
      const newItalic = !currentItalic;
      dispatch({ type: 'SET_DEFAULT_STYLE', isItalic: newItalic });
      if (selectedTextAnnotation) {
        dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { isItalic: newItalic } });
      }
    }
  }, [currentItalic, selectedTextAnnotation, syncActiveEditor]);

  const handleFontFamilyChange = useCallback(
    (family: string) => {
      dispatch({ type: 'SET_DEFAULT_STYLE', fontFamily: family });
      const hadSelection = restoreSelection();
      if (hadSelection && selectedTextAnnotation) {
        const cssFont = FONT_FAMILIES.find((f) => f.value === family)?.css || 'Arial, Helvetica, sans-serif';
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          applyFontFamilyToSelection(cssFont);
          syncActiveEditor();
        } else {
          dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { fontFamily: family } });
        }
      } else if (selectedTextAnnotation) {
        dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { fontFamily: family } });
      }
    },
    [selectedTextAnnotation, syncActiveEditor, restoreSelection]
  );

  const handleFontSizeChange = useCallback(
    (size: number) => {
      dispatch({ type: 'SET_DEFAULT_STYLE', fontSize: size });
      const hadSelection = restoreSelection();
      if (hadSelection && selectedTextAnnotation) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          applyFontSizeToSelection(size);
          syncActiveEditor();
        } else {
          dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { fontSize: size } });
        }
      } else if (selectedTextAnnotation) {
        dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { fontSize: size } });
      }
    },
    [selectedTextAnnotation, syncActiveEditor, restoreSelection]
  );

  const handleColorChange = useCallback(
    (color: string) => {
      dispatch({ type: 'SET_DEFAULT_STYLE', color });

      const info = getActiveEditorInfo();
      if (info && selectedTextAnnotation) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          applyColorToSelection(color);
          syncActiveEditor();
          return;
        }
      }

      const hadSelection = restoreSelection();
      if (hadSelection && selectedTextAnnotation) {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed) {
          applyColorToSelection(color);
          syncActiveEditor();
        } else {
          dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { color } });
        }
      } else if (selectedTextAnnotation) {
        dispatch({ type: 'UPDATE_ANNOTATION', id: selectedTextAnnotation.id, changes: { color } });
      }
    },
    [selectedTextAnnotation, syncActiveEditor, restoreSelection]
  );

  // --- Computed ---


  return {
    state,
    dispatch,
    fileInputRef,
    pdfBytesRef,
    ensurePdfBytes,

    // File handling
    loadPdfFromArrayBuffer,
    handleFileSelect,
    handleDrop,
    handleInputChange,

    // Annotation actions
    handlePageClick,
    handleSignatureDone,
    handleDownload,

    // Text formatting
    handleBoldToggle,
    handleItalicToggle,
    handleFontFamilyChange,
    handleFontSizeChange,
    handleColorChange,
    saveSelection,

    // Computed values
    selectedAnnotation,
    selectedTextAnnotation,
    currentFontFamily,
    currentFontSize,
    currentBold,
    currentItalic,
    currentColor,
    currentSignatureStyle,
  };
}
