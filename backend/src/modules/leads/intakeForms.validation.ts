import { z } from 'zod';

// Intake form field types — a focused subset of matter custom-field types,
// matching what the public form page can render.
export const INTAKE_FIELD_TYPES = [
  'text', 'textarea', 'email', 'phone', 'select',
] as const;

const intakeFieldSchema = z.object({
  // A blank key means "derive one from the label", the same as omitting it: the
  // settings editor sends "" for a field added in the browser.
  key: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().trim().min(1).max(100).optional(),
  ),
  label: z.string().min(1).max(200),
  type: z.enum(INTAKE_FIELD_TYPES),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(200)).max(50).optional(),
});

// The access code on a gated intake form. Applied on CREATE and UPDATE only, so
// codes already stored keep working until the firm next edits one.
//
// Eight characters, not the four this used to allow. Unlike a signing code this
// one is typed by a firm member rather than generated, so `1234` was a legal
// barrier in front of a public URL, and the rate limiter cannot make up the
// difference: any cap loose enough for a real prospect who mistypes leaves a
// four-digit space walkable. `intakeGateLimiter` (5/min per form token) bounds
// the guessing rate; this bounds what there is to guess.
//
// `.nullable()` is load-bearing on the update path: null is how a firm removes
// the code and makes the form fully public, and a bare `.min(8)` would take that
// away along with the short codes.
const accessCodeSchema = z.string()
  .min(8, 'Access code must be at least 8 characters')
  .max(64)
  .nullable()
  .optional();

export const createIntakeFormSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200),
    practiceAreaId: z.string().uuid().nullable().optional(),
    fields: z.array(intakeFieldSchema).max(50).optional(),
    accessCode: accessCodeSchema,
    isActive: z.boolean().optional(),
  }),
});

export const updateIntakeFormSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    practiceAreaId: z.string().uuid().nullable().optional(),
    fields: z.array(intakeFieldSchema).max(50).optional(),
    // null clears the access code; omit to leave unchanged; string sets a new one.
    accessCode: accessCodeSchema,
    isActive: z.boolean().optional(),
  }),
});

export const sendIntakeFormSchema = z.object({
  body: z.object({
    intakeFormTemplateId: z.string().uuid(),
    email: z.string().email().optional(),
  }),
  params: z.object({
    lawFirmId: z.string(),
    leadId: z.string(),
  }).passthrough(),
});
