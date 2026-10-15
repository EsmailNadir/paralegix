import { fitTextToBox as backendPlain } from '../../src/modules/signatures/textFit';
import { fitRichTextToBox as backendRich } from '../../src/modules/signatures/textFitRich';
const { fitTextToBox: frontendPlain } = require('../../../frontend/src/lib/utils/textFit');
const { fitRichTextToBox: frontendRich } = require('../../../frontend/src/lib/utils/textFitRich');

it('preview and PDF stamping consume the same text layout functions', () => {
  expect(frontendPlain).toBe(backendPlain);
  expect(frontendRich).toBe(backendRich);
  const measure = (text: string, size: number) => text.length * size * 0.5;
  const plain = frontendPlain('A long answer that wraps', 55, 30, 12, measure);
  expect(plain.lines.length).toBeGreaterThan(1);
  expect(backendPlain('A long answer that wraps', 55, 30, 12, measure)).toEqual(plain);
  const blocks = [{ bullet: true, runs: [{ text: 'Styled answer', bold: true, italic: false, color: '#ff0000' }] }];
  const rich = backendRich(blocks, 70, 30, 12, measure);
  expect(rich.lines[0].segments.some((segment) => segment.bold && segment.color === '#ff0000')).toBe(true);
  expect(backendRich(blocks, 70, 30, 12, measure)).toEqual(rich);
});
