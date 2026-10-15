/**
 * One PDF page raster never exceeds a fixed pixel budget.
 *
 * react-pdf multiplies the canvas by `window.devicePixelRatio` unless told
 * otherwise. A Letter page at 200% on a 3x display is a 186 MB canvas, and a
 * zoom step holds two rasters of the same page at once. The ratio handed to
 * react-pdf is what bounds that, so it is what these cases read.
 */
import React from 'react';
import { render } from '@testing-library/react';

const pageProps: Array<Record<string, any>> = [];

jest.mock('react-pdf', () => ({
  __esModule: true,
  pdfjs: { GlobalWorkerOptions: {} },
  Page: (props: Record<string, any>) => {
    pageProps.push(props);
    return null;
  },
}));

import PdfCanvasPage, { MAX_CANVAS_PIXELS } from '@/components/ui/PdfCanvasPage';

const nativeRatio = window.devicePixelRatio;

function setDisplayDensity(ratio: number) {
  Object.defineProperty(window, 'devicePixelRatio', { value: ratio, configurable: true });
}

beforeEach(() => {
  pageProps.length = 0;
});

afterEach(() => {
  setDisplayDensity(nativeRatio);
});

it('draws an ordinary page on a 3x display at no more than 2x', () => {
  setDisplayDensity(3);

  render(<PdfCanvasPage pageNumber={1} renderWidth={800} displayWidth={800} displayHeight={1035} />);

  expect(pageProps[0].devicePixelRatio).toBe(2);
});

it('uses the display density as it is when it is inside the cap and the budget', () => {
  setDisplayDensity(1.5);

  render(<PdfCanvasPage pageNumber={1} renderWidth={800} displayWidth={800} displayHeight={1035} />);

  expect(pageProps[0].devicePixelRatio).toBe(1.5);
});

it('lowers the ratio until a large raster fits the pixel budget', () => {
  setDisplayDensity(3);

  render(<PdfCanvasPage pageNumber={1} renderWidth={2000} displayWidth={2000} displayHeight={2588} />);

  const ratio = pageProps[0].devicePixelRatio;
  expect(ratio).toBeLessThan(2);
  expect(2000 * ratio * 2588 * ratio).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
});

it('measures the raster, not the box, while a zoom is scaling one into the other', () => {
  setDisplayDensity(2);

  // Rasterised at twice the width it is shown at: the canvas is 2000 wide and
  // proportionally tall, whatever the on-screen box measures.
  render(<PdfCanvasPage pageNumber={1} renderWidth={2000} displayWidth={1000} displayHeight={1294} />);

  const ratio = pageProps[0].devicePixelRatio;
  expect(2000 * ratio * 2588 * ratio).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
});

it('budgets a page that has not been measured yet as a Letter-shaped one', () => {
  setDisplayDensity(3);

  render(<PdfCanvasPage pageNumber={1} renderWidth={2000} displayWidth={2000} displayHeight={0} />);

  const ratio = pageProps[0].devicePixelRatio;
  expect(2000 * ratio * Math.round(2000 * 1.294) * ratio).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
});

it('never draws below the display\'s own pixel grid on a 1x display', () => {
  setDisplayDensity(1);

  render(<PdfCanvasPage pageNumber={1} renderWidth={800} displayWidth={800} displayHeight={1035} />);

  expect(pageProps[0].devicePixelRatio).toBe(1);
});
