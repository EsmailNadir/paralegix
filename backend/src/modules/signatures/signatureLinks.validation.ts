import { z } from 'zod';
// Bounded paging params, shared so every list agrees on how deep a window may go.
const { pageParam, offsetParam } = require('../../shared/validation/listQuery');

const signatureFieldSchema = z.object({
  // The client's name for the field, unique within its session.
  id: z.string().trim().min(1).max(200),
  page: z.number().int().positive(),
  xPercent: z.number().min(0).max(100),
  yPercent: z.number().min(0).max(100),
  widthPercent: z.number().min(0).max(100),
  heightPercent: z.number().min(0).max(100),
  fieldType: z.enum(['signature', 'initials', 'date', 'text', 'checkbox']).default('signature'),
  label: z.string().max(200).optional(),
  required: z.boolean().optional(),
  style: z.enum(['standard', 'x-line']).optional(),
  signerId: z.string().min(1).optional(),
});

const signerSchema = z.object({
  participantId: z.string().min(1).optional(),
  roleLabel: z.string().min(1).max(100),
  order: z.number().int().positive().optional(),
  deliveryMethod: z.enum(['email', 'portal', 'internal_dashboard', 'internal_email', 'in_person', 'copy_link']).optional(),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().optional(),
  memberUserId: z.string().min(1).optional(),
  clientUserId: z.string().min(1).optional(),
  // Min length raised 4 -> 6 to widen the brute-force search space (combined
  // with the per-gate attempt cap below). Only enforced at create time.
  accessCode: z.string().min(6, 'Access code must be at least 6 characters').max(20).optional(),
});

export const prepareSigningFileSchema = z.object({
  body: z.object({
    objectPath: z.string().min(1).max(2000),
    fileName: z.string().min(1).max(500),
    requireFlatteningConfirmation: z.boolean().optional().default(false),
  }),
});

export const generateLinkSchema = z.object({
  body: z.object({
    objectPath: z.string().min(1),
    fileName: z.string().min(1).max(500),
    fields: z.array(signatureFieldSchema).optional(),
    signers: z.array(signerSchema).min(1).optional(),
    routingMode: z.enum(['sequential', 'parallel']).optional(),
    destinationFolderId: z.string().uuid().optional(),
    destinationLabel: z.string().min(1).max(500).optional(),
    clientId: z.string().min(1).optional(),
    accessCode: z.string().min(6, 'Access code must be at least 6 characters').max(20).optional(),
    emailSignersOnComplete: z.boolean().optional(),
  }),
});

export const sendEmailSchema = z.object({
  body: z.object({
    recipientEmail: z.string().email(),
    recipientName: z.string().min(1).max(200).optional(),
    objectPath: z.string().min(1),
    fileName: z.string().min(1).max(500),
    fields: z.array(signatureFieldSchema).optional(),
    message: z.string().max(2000).optional(),
    replyToEmail: z.string().email().optional(),
    routingMode: z.enum(['sequential', 'parallel']).optional(),
    destinationFolderId: z.string().uuid().optional(),
    destinationLabel: z.string().min(1).max(500).optional(),
    accessCode: z.string().min(6, 'Access code must be at least 6 characters').max(20).optional(),
    emailSignersOnComplete: z.boolean().optional(),
  }),
});

export const sendSigningRequestSchema = z.object({
  body: z.object({
    objectPath: z.string().min(1),
    fileName: z.string().min(1).max(500),
    fields: z.array(signatureFieldSchema).optional(),
    signers: z.array(signerSchema).min(1),
    routingMode: z.enum(['sequential', 'parallel']).optional(),
    message: z.string().max(2000).optional(),
    replyToEmail: z.string().email().optional(),
    destinationFolderId: z.string().uuid().optional(),
    destinationLabel: z.string().min(1).max(500).optional(),
    emailSignersOnComplete: z.boolean().optional(),
  }).superRefine((body, ctx) => {
    // One signer may sign without placed fields (the fieldless transport, as
    // "Send to portal" uses). Several signers need fields so each knows where
    // their own signature goes.
    if (body.signers.length > 1 && !(body.fields && body.fields.length > 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fields'],
        message: 'Place at least one field when sending to more than one signer',
      });
    }
  }),
});

// GET /signature-links/recipients - the dedicated portal-recipient picker
// (organization-clients plan Phase 8). `clientId` optionally narrows to one
// client record's own recipients (its roster, for a company).
export const listSigningRecipientsSchema = z.object({
  query: z.object({
    search: z.string().max(200).optional(),
    clientId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

// Paging/filtering for the firm signing history. `not_completed` is a synthetic
// value matching every session that has not been fully signed; the rest are real
// session statuses.
export const listSessionsSchema = z.object({
  query: z.object({
    limit: z.coerce.number().int().min(1).max(200).optional(),
    offset: offsetParam,
    page: pageParam,
    status: z.enum([
      'not_completed', 'pending', 'in_progress', 'completed', 'cancelled', 'declined', 'expired',
    ]).optional(),
    search: z.string().max(200).optional(),
  }),
});
