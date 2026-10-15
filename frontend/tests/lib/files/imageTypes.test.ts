/**
 * Which images a browser can draw in an <img> tag.
 *
 * HEIC and HEIF are the iPhone camera default and render only in Safari; TIFF
 * renders nowhere. Handed to an <img> they show a broken image. What has to
 * break for these to go red: treat every `image/` type as renderable, or ignore
 * the file extension when the type is generic.
 */
import {
  isBrowserRenderableImage,
  isHeicFormat,
  isNativeHeicSupported,
} from '@/lib/files/imageTypes';

it('draws the formats every browser decodes', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
    expect(isBrowserRenderableImage(type, 'photo')).toBe(true);
  }
});

it('refuses HEIC, HEIF and TIFF by type', () => {
  for (const type of ['image/heic', 'image/heif', 'image/tiff', 'image/tif']) {
    expect(isBrowserRenderableImage(type, 'photo')).toBe(false);
  }
});

it('refuses them by extension when the type is generic', () => {
  expect(isBrowserRenderableImage('image/jpeg', 'IMG_0412.HEIC')).toBe(false);
});

it('is not an image at all when the type is not one', () => {
  expect(isBrowserRenderableImage('application/pdf', 'scan.jpg')).toBe(false);
});

it('detects HEIC format by mimetype and extension', () => {
  expect(isHeicFormat('image/heic')).toBe(true);
  expect(isHeicFormat('image/heif')).toBe(true);
  expect(isHeicFormat('application/octet-stream', 'photo.heic')).toBe(true);
  expect(isHeicFormat('application/octet-stream', 'photo.HEIF')).toBe(true);
  expect(isHeicFormat('image/jpeg', 'photo.jpg')).toBe(false);
});

it('allows HEIC when native Safari rendering is detected', () => {
  const originalUA = navigator.userAgent;
  try {
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      configurable: true,
    });
    expect(isNativeHeicSupported()).toBe(true);
    expect(isBrowserRenderableImage('image/heic', 'IMG_0001.HEIC')).toBe(true);
  } finally {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUA,
      configurable: true,
    });
  }
});
