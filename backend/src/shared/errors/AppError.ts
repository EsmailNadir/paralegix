/**
 * The error hierarchy the central errorHandler translates into HTTP responses.
 *
 * `message` is user-facing copy: it becomes the `error` field of the response
 * envelope, so it is written for the end user rather than for a log reader.
 */
export class AppError extends Error {
  readonly statusCode: number;

  readonly code: string;

  /**
   * Sent as the `Retry-After` header by the error handler. Set it on a refusal
   * caused by load (a full queue, a busy converter) so the client knows the
   * same request will work later and how long to wait first.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    statusCode = 500,
    code = 'INTERNAL_ERROR',
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    if (options.retryAfterSeconds) this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 404, 'NOT_FOUND');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied') {
    super(message, 403, 'FORBIDDEN');
  }
}

/**
 * The shapes `ValidationError` accepts: a plain string, a Zod `flatten()`
 * result, or an ad-hoc field map (`{ email: ['msg'] }` / `{ dependency: 'msg' }`).
 */
export type ValidationDetails =
  | string
  | {
    formErrors?: unknown;
    fieldErrors?: Record<string, unknown>;
    [key: string]: unknown;
  };

// Pull the first human-readable message out of validation details so the
// top-level `error` string tells the user what is actually wrong instead of
// a generic "Validation failed". Details arrive in three shapes: a plain
// string, a Zod `flatten()` result ({ formErrors, fieldErrors }), or an
// ad-hoc field map ({ email: ['msg'] } / { dependency: 'msg' }).
function firstValidationMessage(details: ValidationDetails): string {
  if (typeof details === 'string' && details.trim()) return details;
  if (details && typeof details === 'object') {
    const fieldMap: Record<string, unknown> = details.fieldErrors && typeof details.fieldErrors === 'object'
      ? details.fieldErrors
      : details;
    const { formErrors } = details;
    if (Array.isArray(formErrors) && typeof formErrors[0] === 'string' && formErrors[0]) {
      return formErrors[0];
    }
    for (const value of Object.values(fieldMap)) {
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && typeof value[0] === 'string' && value[0]) return value[0];
    }
  }
  return 'Validation failed';
}

export class ValidationError extends AppError {
  readonly details: ValidationDetails;

  constructor(details: ValidationDetails) {
    super(firstValidationMessage(details), 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

/**
 * An invoice, payment request, or billing email has nobody to go to: the client
 * carries no billing address and, for a company, no related client is enabled
 * as an email recipient. Distinct from a validation failure because nothing
 * the caller submitted is malformed - the firm's client data is incomplete -
 * and distinct from a Stripe/transport failure because no external call was
 * even attempted.
 */
export class NoBillingRecipientError extends AppError {
  constructor(message = 'This client has no billing recipient on file.') {
    super(message, 400, 'NO_BILLING_RECIPIENT');
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists') {
    super(message, 409, 'CONFLICT');
  }
}

/** What `enforceCountLimit` / `enforceFeatureAccess` attach for the client. */
export interface PlanLimitDetails {
  current?: number;
  limit?: number;
  planId?: string;
}

export class PlanLimitError extends AppError {
  readonly details: PlanLimitDetails & { resource: string };

  constructor(resource: string, { current, limit, planId }: PlanLimitDetails = {}) {
    super(`Plan limit reached: ${resource}`, 403, 'PLAN_LIMIT_REACHED');
    this.details = { resource, current, limit, planId };
  }
}
