import { z } from 'zod';

export const VALID_FIELD_TYPES = [
  'text', 'textarea', 'number', 'currency', 'date',
  'select', 'multiselect', 'checkbox', 'url', 'email', 'phone',
];

// A choice for select / multiselect fields. Accept a plain string or a
// { label, value } object; the service normalizes to { label, value }.
const optionSchema = z.union([
  z.string(),
  z.object({ label: z.string(), value: z.string().optional() }),
]);

export const createFieldDefSchema = z.object({
  body: z.object({
    label: z.string().min(1).max(100),
    fieldType: z.enum(VALID_FIELD_TYPES).optional(),
    practiceAreaId: z.string().nullable().optional(),
    options: z.array(optionSchema).optional(),
    helpText: z.string().max(500).nullable().optional(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
  }),
});

export const updateFieldDefSchema = z.object({
  body: z.object({
    label: z.string().min(1).max(100).optional(),
    fieldType: z.enum(VALID_FIELD_TYPES).optional(),
    practiceAreaId: z.string().nullable().optional(),
    options: z.array(optionSchema).optional(),
    helpText: z.string().max(500).nullable().optional(),
    required: z.boolean().optional(),
    sortOrder: z.number().int().optional(),
    archived: z.boolean().optional(),
  }),
});
