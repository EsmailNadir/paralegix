import { reflowFilledTemplate as backendReflow } from '../../src/shared/documentConversion/templateReflow';
const { reflowFilledTemplate: frontendReflow } = require('../../../frontend/src/components/templatesComp/templateReflow');
import { runInNewContext } from 'vm';

it('preview and PDF export consume one serializable layout function', () => {
  expect(frontendReflow).toBe(backendReflow);
  const querySelectorAll = jest.fn(() => []);
  runInNewContext(`(${backendReflow.toString()})()`, { document: { querySelectorAll } });
  expect(querySelectorAll).toHaveBeenCalledWith('.pdf-page');
});
