import { z } from 'zod';

// Public, unauthenticated endpoints (see intake.routes.ts) — no verifyToken, so
// these schemas are the only gate between the open internet and intake.service.
// Per-field business rules (email format, select options, required-ness) still
// live in intake.service's validateFieldValues, which is template-driven and
// cannot be expressed statically here; this layer only bounds the HTTP-level
// shape (sizes, types) before that runs.

const tokenParams = z.object({
  token: z.string().min(1).max(200),
}).passthrough();

// A submitted field's value: intake fields render as text/textarea/email/phone/
// select (see leads/intakeForms.validation.ts INTAKE_FIELD_TYPES), all of which
// serialize to a string on submit; null/omitted clears an optional field.
const fieldValueSchema = z.union([z.string().max(5000), z.null()]);

// Keyed by the template's field `key` (max 100 chars, matching intakeFieldSchema),
// capped at 100 entries — comfortably above the 50-field template cap so a
// generic-embed submission's extra well-known keys (name/email/phone/...) still
// fit, while still bounding the payload against arbitrary abuse.
const fieldValuesSchema = z.record(z.string().min(1).max(100), fieldValueSchema)
  .refine((values) => Object.keys(values).length <= 100, {
    message: 'Too many fields submitted',
  })
  .optional();

export const getIntakeFormSchema = z.object({
  params: tokenParams,
});

export const verifyAccessCodeSchema = z.object({
  params: tokenParams,
  body: z.object({
    code: z.string().min(1).max(100),
  }),
});

export const submitIntakeSchema = z.object({
  params: tokenParams,
  body: z.object({
    fieldValues: fieldValuesSchema,
    accessCode: z.string().min(1).max(100).optional(),
  }),
});
