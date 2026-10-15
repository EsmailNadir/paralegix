'use client';

import dynamic from 'next/dynamic';

export { MAX_RENDERED_CANVASES } from '@/hooks/usePdfPageWindow';

/**
 * The PDF viewer, loaded in the browser only.
 *
 * pdf.js reaches for browser globals (`DOMMatrix`) the moment its module is
 * evaluated, and a `'use client'` component is still rendered once on the
 * server. Imported statically, the viewer took down the server render of every
 * page that could open a preview, the public share page among them. Loading it
 * here keeps every caller's import unchanged. The viewer itself is
 * `PdfPreviewDocument`.
 */
const PdfPreview = dynamic(() => import('./PdfPreviewDocument'), { ssr: false });

export default PdfPreview;
