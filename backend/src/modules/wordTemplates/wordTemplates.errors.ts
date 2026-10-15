import { AppError } from '../../shared/errors/AppError';
import type { LeftoverClientText } from './lib/auto-bracket/known-values';

/**
 * A refusal the review dialog acts on rather than just displays. The central
 * error handler sends `details` beside the message, which is how the browser
 * learns which template already holds a name, or which client details would
 * stay in a document.
 */
export class WordTemplateRefusal extends AppError {
  readonly details: Record<string, unknown>;

  constructor(message: string, statusCode: number, code: string, details: Record<string, unknown>) {
    super(message, statusCode, code);
    this.details = details;
  }
}

/** A same-name template exists and the caller chose neither Replace nor Copy. */
export function duplicateRefusal(message: string, duplicate: { id: string; name: string }) {
  return new WordTemplateRefusal(message, 409, 'TEMPLATE_DUPLICATE', { duplicate });
}

/** A firm client's details would be stored in the template as plain text. */
export function leftoverRefusal(leftovers: LeftoverClientText[]) {
  return new WordTemplateRefusal(
    'Client details would stay in this template. Review them before saving.',
    409,
    'TEMPLATE_CLIENT_TEXT',
    { leftovers, clientTextRefused: true },
  );
}

/** The guard could not run, so nothing is stored. */
export function clientTextUncheckable(message: string, statusCode: number, code: string) {
  return new WordTemplateRefusal(message, statusCode, code, { clientTextRefused: true });
}
