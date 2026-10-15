import type { NextFunction, Request, Response } from 'express';

const { ValidationError } = require('../errors/AppError');

/** The request sections a schema may describe. */
type Section = 'body' | 'query' | 'params';
const SECTIONS: readonly Section[] = ['body', 'query', 'params'];

/**
 * The shape `validate()` needs from a schema.
 *
 * Typed as a discriminated union rather than `any` so `result.data` is only
 * reachable after `result.success` has been checked, which is what makes the
 * write-back below provably run on a successful parse only.
 */
interface RequestSchema {
  safeParse(input: unknown):
    | { success: true; data: Partial<Record<Section, unknown>> }
    | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

/**
 * Writes a parsed section back onto the request.
 *
 * Parsed keys are merged over the originals rather than replacing the section
 * wholesale. Zod strips every key a schema does not declare, and the schemas
 * here are deliberately partial (a list route validates `limit` and `page` while
 * reading a dozen more filters it never declares), so replacing would silently
 * drop the fields those routes depend on. Merging only ever adds the coercions,
 * defaults and transforms the schema asked for.
 *
 * `req.query` is a getter with no setter in Express 5, and it re-derives the
 * object from the URL on every read, so mutating what it returns is discarded.
 * An own property is defined on the request to shadow the prototype getter.
 */
function writeBack(req: Request, section: Section, parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

  const current = req[section] as Record<string, unknown> | undefined;
  const merged = { ...current, ...(parsed as Record<string, unknown>) };

  if (section === 'query') {
    Object.defineProperty(req, 'query', {
      value: merged,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    return;
  }

  req[section] = merged as never;
}

export function validate(schema: RequestSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse({
      body: req.body,
      query: req.query,
      params: req.params,
    });

    if (!result.success) {
      const fieldErrors: Record<string, string[]> = {};
      for (const issue of result.error.issues) {
        const field = issue.path.slice(1).join('.') || String(issue.path[0] ?? 'form');
        (fieldErrors[field] ||= []).push(issue.message);
      }
      throw new ValidationError({ fieldErrors });
    }

    // Without this the parsed value is discarded and every `z.coerce`, `.default()`
    // and `.transform()` in a schema is validation-only: the handler still reads the
    // raw string off the query, or `undefined` where a default was declared.
    for (const section of SECTIONS) writeBack(req, section, result.data[section]);

    next();
  };
}
