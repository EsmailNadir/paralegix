/**
 * Image formats a browser can decode in an <img> tag.
 *
 * HEIC and HEIF (the iPhone camera default) render only in Safari, and TIFF
 * renders nowhere. Handed to an <img> they show a broken image, so every place
 * that previews an image asks this first and offers the download instead.
 */
const NON_RENDERABLE_IMAGE = /\b(heic|heif|tiff?)$/i;

/**
 * Detects whether the content type or file name indicates an HEIC/HEIF image.
 */
export function isHeicFormat(contentType: string, fileName = ''): boolean {
  const type = (contentType || '').toLowerCase();
  if (/\b(heic|heif)$/i.test(type)) return true;
  const ext = fileName.includes('.') ? (fileName.split('.').pop() || '').toLowerCase() : '';
  return ext === 'heic' || ext === 'heif';
}

/**
 * Checks if the browser natively supports decoding HEIC in an <img> tag.
 * Apple platforms running Safari / WebKit (macOS Safari, iOS, iPadOS) decode HEIC natively.
 */
export function isNativeHeicSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isSafari = /^((?!chrome|android).)*safari/i.test(ua);
  return isIOS || isSafari;
}

export function isBrowserRenderableImage(contentType: string, fileName = ''): boolean {
  const type = (contentType || '').toLowerCase();
  if (!type.startsWith('image/')) return false;
  if (isHeicFormat(type, fileName)) {
    return isNativeHeicSupported();
  }
  if (NON_RENDERABLE_IMAGE.test(type)) return false;
  const ext = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
  return !NON_RENDERABLE_IMAGE.test(ext);
}
