'use client';

import { useId, useRef, useState, useCallback, useEffect } from 'react';
import SignatureCanvas from 'react-signature-canvas';
import { X } from 'lucide-react';
import Dropdown from '@/components/ui/Dropdown';
import Modal from '@/components/ui/Modal';
import { FULL_INPUT_CLS } from '@/components/ui/inputClasses';
import type { SignatureStyle } from '@/types/signature';
import { resolveSignatureStyle } from '@/types/signature';
import TabBar from '@/components/ui/TabBar';
import FieldLabel from '@/components/ui/FieldLabel';
import { useResetAfterClose } from '@/hooks/useMountTransition';

/** Scale factor for signature capture. Higher = sharper in PDF output */
const SIG_RENDER_SCALE = 3;

const SIGNATURE_FONTS = [
  // Script / cursive (Google Fonts)
  { label: 'Dancing Script', css: "'Dancing Script', cursive", google: 'Dancing+Script:wght@400;700' },
  { label: 'Great Vibes', css: "'Great Vibes', cursive", google: 'Great+Vibes' },
  { label: 'Caveat', css: "'Caveat', cursive", google: 'Caveat:wght@400;700' },
  { label: 'Sacramento', css: "'Sacramento', cursive", google: 'Sacramento' },
  // System fonts (same as open signing toolbar)
  { label: 'Arial', css: 'Arial, Helvetica, sans-serif', google: null },
  { label: 'Times New Roman', css: "'Times New Roman', Times, serif", google: null },
  { label: 'Courier New', css: "'Courier New', Courier, monospace", google: null },
  { label: 'Calibri', css: "Calibri, Carlito, Arial, sans-serif", google: null },
  { label: 'Cambria', css: "Cambria, Georgia, serif", google: null },
  { label: 'Georgia', css: 'Georgia, serif', google: null },
  { label: 'Verdana', css: 'Verdana, Geneva, sans-serif', google: null },
  { label: 'Tahoma', css: 'Tahoma, Geneva, sans-serif', google: null },
  { label: 'Trebuchet MS', css: "'Trebuchet MS', Helvetica, sans-serif", google: null },
  { label: 'Garamond', css: 'Garamond, serif', google: null },
  { label: 'Palatino', css: "'Palatino Linotype', 'Book Antiqua', Palatino, serif", google: null },
  { label: 'Didot', css: "Didot, 'Bodoni MT', serif", google: null },
  { label: 'Futura', css: 'Futura, sans-serif', google: null },
  { label: 'Optima', css: 'Optima, sans-serif', google: null },
  { label: 'Avenir', css: "'Avenir Next', Avenir, sans-serif", google: null },
  { label: 'Lucida Console', css: "'Lucida Console', Monaco, monospace", google: null },
  { label: 'Comic Sans MS', css: "'Comic Sans MS', cursive", google: null },
  { label: 'Impact', css: 'Impact, Charcoal, sans-serif', google: null },
  { label: 'Brush Script MT', css: "'Brush Script MT', cursive", google: null },
];

const SIGNATURE_SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];
const DEFAULT_SIGNATURE_FONT = SIGNATURE_FONTS.find((f) => f.label === 'Great Vibes')!;
const GOOGLE_FONTS_LINK_ID = 'signature-google-fonts';

let signatureFontsStylesheetPromise: Promise<void> | null = null;

function getPrimaryFontFamily(cssFamily: string) {
  return cssFamily.split(',')[0]?.trim() || cssFamily;
}

function ensureSignatureFontsStylesheet() {
  if (typeof document === 'undefined') {
    return Promise.resolve();
  }

  if (!signatureFontsStylesheetPromise) {
    signatureFontsStylesheetPromise = new Promise((resolve) => {
      const existingLink = document.getElementById(GOOGLE_FONTS_LINK_ID) as HTMLLinkElement | null;

      if (existingLink?.sheet) {
        existingLink.dataset.loaded = 'true';
        resolve();
        return;
      }

      const finish = () => resolve();
      const attachListeners = (link: HTMLLinkElement) => {
        if (link.dataset.loaded === 'true') {
          finish();
          return;
        }

        const markLoaded = () => {
          link.dataset.loaded = 'true';
          finish();
        };

        link.addEventListener('load', markLoaded, { once: true });
        link.addEventListener('error', finish, { once: true });
      };

      if (existingLink) {
        attachListeners(existingLink);
        return;
      }

      const families = SIGNATURE_FONTS
        .filter((f) => f.google)
        .map((f) => f.google)
        .join('&family=');

      if (!families) {
        finish();
        return;
      }

      const link = document.createElement('link');
      link.id = GOOGLE_FONTS_LINK_ID;
      link.rel = 'stylesheet';
      link.href = `https://fonts.googleapis.com/css2?family=${families}&display=swap`;
      attachListeners(link);
      document.head.appendChild(link);
    });
  }

  return signatureFontsStylesheetPromise;
}

interface SignatureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDone: (signatureDataUrl: string, style: SignatureStyle) => void;
  initialStyle?: SignatureStyle;
  lockedStyle?: SignatureStyle;
  fieldType?: 'signature' | 'initials';
}

type Tab = 'draw' | 'type';

export default function SignatureModal({ isOpen, onClose, onDone, initialStyle, lockedStyle, fieldType = 'signature' }: SignatureModalProps) {
  const fieldIds = useId();
  const canvasRef = useRef<SignatureCanvas>(null);
  const [activeTab, setActiveTab] = useState<Tab>('draw');
  const [typedText, setTypedText] = useState('');
  const [hasDrawn, setHasDrawn] = useState(false);
  const [selectedFont, setSelectedFont] = useState(DEFAULT_SIGNATURE_FONT);
  const [selectedSize, setSelectedSize] = useState(48);
  const [selectedStyle, setSelectedStyle] = useState<SignatureStyle>(resolveSignatureStyle(initialStyle));
  const [isSavingSignature, setIsSavingSignature] = useState(false);
  const styleLocked = !!lockedStyle;

  // Block close (Escape, backdrop click, and the header close button) while a
  // signature is saving, matching the disabled state of the footer buttons.
  const handleDialogClose = useCallback(() => {
    if (isSavingSignature) return;
    onClose();
  }, [isSavingSignature, onClose]);

  // Preload Google Fonts used for typed signatures.
  useEffect(() => {
    void ensureSignatureFontsStylesheet();
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- syncs user-editable style selection to the incoming style props when the modal opens
    setSelectedStyle(resolveSignatureStyle(lockedStyle ?? initialStyle));
  }, [isOpen, initialStyle, lockedStyle]);

  const resetModalState = useCallback(() => {
    canvasRef.current?.clear();
    setHasDrawn(false);
    setTypedText('');
    setSelectedFont(DEFAULT_SIGNATURE_FONT);
    setSelectedSize(48);
    setSelectedStyle(resolveSignatureStyle(initialStyle));
    setActiveTab('draw');
  }, [initialStyle]);

  // Done clears the signature so the next field starts empty, and Cancel keeps it
  // for a second try. Callers close the dialog from onDone, so the clear waits
  // for the exit animation: clearing first would blank the canvas (an
  // imperative clear) while the dialog is still fading out.
  const resetAfterDoneRef = useRef(false);
  useResetAfterClose(isOpen, () => {
    if (!resetAfterDoneRef.current) return;
    resetAfterDoneRef.current = false;
    resetModalState();
  });

  const handleClear = useCallback(() => {
    if (isSavingSignature) return;
    if (activeTab === 'draw') {
      canvasRef.current?.clear();
      setHasDrawn(false);
    } else {
      setTypedText('');
    }
  }, [activeTab, isSavingSignature]);

  const handleDone = useCallback(async () => {
    if (isSavingSignature) return;
    const finalStyle = resolveSignatureStyle(lockedStyle ?? selectedStyle);
    setIsSavingSignature(true);

    try {
      if (activeTab === 'draw') {
        if (!canvasRef.current || canvasRef.current.isEmpty()) return;
        const dataUrl = exportDrawnSignature(canvasRef.current.getCanvas()).toDataURL('image/png');
        resetAfterDoneRef.current = true;
        onDone(dataUrl, finalStyle);
        return;
      }

      if (!typedText.trim()) return;

      const primaryFontFamily = getPrimaryFontFamily(selectedFont.css);
      const fontFaceSet = document.fonts;

      if (selectedFont.google) {
        await ensureSignatureFontsStylesheet();
      }

      if (fontFaceSet) {
        try {
          await fontFaceSet.load(`${selectedSize}px ${primaryFontFamily}`, typedText.trim());
          await fontFaceSet.ready;
        } catch {
          // Fall back to the browser font stack if the preferred font is unavailable.
        }
      }

      const canvas = document.createElement('canvas');
      const baseW = 600;
      const baseH = 200;
      canvas.width = baseW * SIG_RENDER_SCALE;
      canvas.height = baseH * SIG_RENDER_SCALE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.scale(SIG_RENDER_SCALE, SIG_RENDER_SCALE);
      ctx.clearRect(0, 0, baseW, baseH);
      ctx.font = `${selectedSize}px ${selectedFont.css}`;
      ctx.fillStyle = '#000000';
      ctx.textBaseline = 'middle';

      // Auto-scale down if text is too wide for the canvas.
      const textWidth = ctx.measureText(typedText).width;
      const maxWidth = baseW - 20;
      if (textWidth > maxWidth) {
        const scaledSize = Math.floor(selectedSize * (maxWidth / textWidth));
        ctx.font = `${scaledSize}px ${selectedFont.css}`;
      }

      const metrics = ctx.measureText(typedText);
      const x = Math.max(10, (baseW - metrics.width) / 2);
      ctx.fillText(typedText, x, baseH / 2);

      // Trim to content, then add padding inversely proportional to font size
      // so large fonts fill the field and small fonts appear smaller.
      const trimmed = trimCanvas(canvas);
      const padRatio = Math.max(0, 1 - selectedSize / 72) * 0.3;
      const padX = Math.round(trimmed.width * padRatio);
      const padY = Math.round(trimmed.height * padRatio);

      const dataUrl = (() => {
        if (padX === 0 && padY === 0) {
          return trimmed.toDataURL('image/png');
        }

        const output = document.createElement('canvas');
        output.width = trimmed.width + padX * 2;
        output.height = trimmed.height + padY * 2;
        const oCtx = output.getContext('2d');
        oCtx?.drawImage(trimmed, padX, padY);
        return output.toDataURL('image/png');
      })();

      resetAfterDoneRef.current = true;
      onDone(dataUrl, finalStyle);
    } finally {
      setIsSavingSignature(false);
    }
  }, [activeTab, typedText, selectedFont, selectedSize, onDone, selectedStyle, lockedStyle, isSavingSignature]);

  const canSubmit =
    (activeTab === 'draw' && hasDrawn) || (activeTab === 'type' && typedText.trim().length > 0);

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleDialogClose}
      dismissible={!isSavingSignature}
      title={fieldType === 'initials' ? 'Add Initials' : 'Add Signature'}
      size="lg"
      className="rounded-xl overflow-hidden"
      closeIcon={<X className="w-5 h-5" />}
      bodyClassName={null}
    >
        {/* Tabs */}
        <TabBar
          density="compact"
          className="px-3"
          tabs={[
            { value: 'draw' as const, label: 'Draw', disabled: isSavingSignature },
            { value: 'type' as const, label: 'Type', disabled: isSavingSignature },
          ]}
          value={activeTab}
          onChange={setActiveTab}
        />

        {/* Content */}
        <div className="p-5">
          {!styleLocked && (
            <div className="mb-4 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-on-surface-muted">Signature layout</p>
              <div className="flex items-center rounded-lg bg-surface-alt p-1 gap-0.5">
                <button
                  onClick={() => setSelectedStyle('standard')}
                  className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                    selectedStyle === 'standard'
                      ? 'bg-accent-solid text-accent-foreground shadow-sm'
                      : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover'
                  }`}
                >
                  Signature only
                </button>
                <button
                  onClick={() => setSelectedStyle('x-line')}
                  className={`flex-1 px-3 py-2 rounded-md text-sm font-medium transition-colors cursor-pointer ${
                    selectedStyle === 'x-line'
                      ? 'bg-accent-solid text-accent-foreground shadow-sm'
                      : 'text-on-surface-secondary hover:text-on-surface hover:bg-surface-hover'
                  }`}
                >
                  X + ____
                </button>
              </div>
            </div>
          )}

          {activeTab === 'draw' ? (
            <div className="space-y-3">
              {selectedStyle === 'x-line' && (
                <div className="flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-sm text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-300">
                  <span className="font-semibold">X + ____</span>
                  <span>Your signature will be placed on the line automatically.</span>
                </div>
              )}
              <div className="border border-outline-subtle rounded-lg overflow-hidden bg-white">
                <SignatureCanvas
                  ref={canvasRef}
                  penColor="black"
                  clearOnResize={false}
                  canvasProps={{
                    width: 460,
                    height: 180,
                    className: 'block w-full touch-none',
                    style: { width: '100%', height: '180px', touchAction: 'none' },
                  }}
                  onBegin={() => setHasDrawn(true)}
                />
                {/* Baseline guide */}
                <div className="h-px bg-gray-200 mx-6 -mt-12" />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <FieldLabel htmlFor={`${fieldIds}-typedtext`}>
                  {fieldType === 'initials' ? 'Initials' : 'Signature'} *
                </FieldLabel>
                <input
                  id={`${fieldIds}-typedtext`}
                  type="text"
                  value={typedText}
                  onChange={(e) => setTypedText(e.target.value)}
                  placeholder={fieldType === 'initials' ? 'Type your initials...' : 'Type your signature...'}
                  className={FULL_INPUT_CLS}
                  disabled={isSavingSignature}
                  autoFocus
                />
              </div>

              {/* Font & size selectors */}
              <div className="flex items-center gap-3">
                <Dropdown
                  portal
                  value={selectedFont.label}
                  onChange={(value) => {
                    const font = SIGNATURE_FONTS.find((f) => f.label === value);
                    if (font) setSelectedFont(font);
                  }}
                  disabled={isSavingSignature}
                  options={SIGNATURE_FONTS.map((font) => ({
                    value: font.label,
                    label: font.label,
                  }))}
                  className="w-[180px]"
                  buttonClassName="h-9 rounded-md border-input-border bg-input-bg px-2 text-sm"
                />
                <Dropdown
                  portal
                  value={String(selectedSize)}
                  onChange={(value) => setSelectedSize(Number(value))}
                  disabled={isSavingSignature}
                  options={SIGNATURE_SIZES.map((size) => ({
                    value: String(size),
                    label: `${size}px`,
                  }))}
                  className="w-[86px]"
                  buttonClassName="h-9 rounded-md border-input-border bg-input-bg px-2 text-sm"
                />
              </div>

              {/* Preview */}
              <div className="h-24 border border-outline-subtle rounded-lg bg-white overflow-hidden">
                {selectedStyle === 'x-line' ? (
                  <div className="h-full flex items-end gap-2 px-4 pb-4">
                    <span className="text-black text-lg font-semibold leading-none">X</span>
                    <div className="relative flex-1 h-full">
                      <div className="absolute left-0 right-0 bottom-3 border-b border-black" />
                      <span
                        className="absolute inset-x-2 bottom-4 text-center text-black"
                        style={{ fontFamily: selectedFont.css, fontSize: `${selectedSize}px` }}
                      >
                        {typedText || 'Preview'}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex items-center justify-center">
                    <span
                      className="text-black px-4"
                      style={{ fontFamily: selectedFont.css, fontSize: `${selectedSize}px` }}
                    >
                      {typedText || 'Preview'}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-outline-subtle">
          <button
            onClick={handleClear}
            disabled={isSavingSignature}
            className="px-4 py-2 text-sm font-medium text-on-surface-muted hover:text-on-surface transition-colors cursor-pointer"
          >
            Clear
          </button>
          <div className="flex gap-3">
            <button
              onClick={onClose}
              disabled={isSavingSignature}
              className="px-4 py-2 text-sm font-medium text-on-surface-secondary hover:text-on-surface rounded-lg border border-outline-subtle hover:bg-surface-hover transition-[background-color,color,transform] active:scale-[0.96] motion-reduce:active:scale-100 cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleDone}
              disabled={!canSubmit || isSavingSignature}
              className="px-6 py-2 text-sm font-medium text-accent-foreground bg-accent-solid rounded-lg hover:bg-accent-solid-hover disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-[background-color,transform] active:scale-[0.96] motion-reduce:active:scale-100"
            >
              Done
            </button>
          </div>
        </div>
    </Modal>
  );
}

function exportDrawnSignature(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const trimmed = trimCanvas(canvas);
  const output = document.createElement('canvas');
  output.width = Math.max(1, trimmed.width * SIG_RENDER_SCALE);
  output.height = Math.max(1, trimmed.height * SIG_RENDER_SCALE);

  const ctx = output.getContext('2d');
  if (!ctx) return trimmed;

  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(trimmed, 0, 0, output.width, output.height);
  return output;
}

/** Trim transparent pixels from a canvas */
function trimCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = pixels;
  let top = height,
    bottom = 0,
    left = width,
    right = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha > 0) {
        if (y < top) top = y;
        if (y > bottom) bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }

  if (top > bottom || left > right) return canvas;

  const pad = 10;
  top = Math.max(0, top - pad);
  left = Math.max(0, left - pad);
  bottom = Math.min(height - 1, bottom + pad);
  right = Math.min(width - 1, right + pad);

  const trimmedWidth = right - left + 1;
  const trimmedHeight = bottom - top + 1;
  const trimmed = document.createElement('canvas');
  trimmed.width = trimmedWidth;
  trimmed.height = trimmedHeight;
  const tCtx = trimmed.getContext('2d');
  tCtx?.drawImage(canvas, left, top, trimmedWidth, trimmedHeight, 0, 0, trimmedWidth, trimmedHeight);
  return trimmed;
}
