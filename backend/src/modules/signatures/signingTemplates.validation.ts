import { z } from 'zod';

// Template fields store their signer assignment as a role reference ("role:N")
// that points at a signerRole.order. Kept in sync with the frontend constant of
// the same value in SignatureFieldPlacer.
const TEMPLATE_ROLE_REF_PREFIX = 'role:';

const signatureFieldSchema = z.object({
  id: z.string().min(1),
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

const signerRoleSchema = z.object({
  roleLabel: z.string().min(1).max(100),
  order: z.number().int().positive(),
  deliveryMethod: z.enum(['email', 'portal', 'internal_dashboard', 'copy_link', 'internal_email', 'in_person']).optional(),
});

const templateBodyObject = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  fields: z.array(signatureFieldSchema).min(1),
  signerRoles: z.array(signerRoleSchema).min(1),
  sourceFileName: z.string().min(1).max(500).optional(),
  sourceObjectPath: z.string().min(1).max(2000).optional(),
  routingMode: z.enum(['sequential', 'parallel']).optional(),
});

// Cross-field integrity. The per-field schema can't express these because they
// depend on the fields array (and the signerRoles array) as a whole:
//   1. Field ids must be unique within a template.
//   2. Every field that references a signer role ("role:N") must point at a
//      role that actually exists in signerRoles.
// Without (2) a malformed template is accepted and then silently reassigns the
// orphaned field to the first signer when it is loaded back into the editor.
// Runs on the fields/signerRoles that are present, so it also applies to the
// partial update body (which may omit one or both).
interface TemplateField { id?: unknown; signerId?: unknown }
interface TemplateBody { fields?: unknown; signerRoles?: unknown }

function checkTemplateStructure(body: TemplateBody, ctx: z.RefinementCtx) {
  if (!Array.isArray(body.fields)) return;

  const fields = body.fields as TemplateField[];
  const ids = fields.map((field) => field.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields'],
      message: 'Field IDs must be unique within a template.',
    });
  }

  if (!Array.isArray(body.signerRoles)) return;

  const roleOrders = new Set((body.signerRoles as Array<{ order?: unknown }>).map((role) => role.order));
  const hasDanglingRole = fields.some((field) => {
    if (typeof field.signerId !== 'string' || !field.signerId.startsWith(TEMPLATE_ROLE_REF_PREFIX)) return false;
    const order = Number(field.signerId.slice(TEMPLATE_ROLE_REF_PREFIX.length));
    return !roleOrders.has(order);
  });
  if (hasDanglingRole) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields'],
      message: 'Every field must be assigned to an existing signer role.',
    });
  }
}

const templateParamsSchema = z.object({
  lawFirmId: z.string().min(1),
  templateId: z.string().min(1),
});

export const createSigningTemplateSchema = z.object({
  params: z.object({
    lawFirmId: z.string().min(1),
  }),
  body: templateBodyObject.superRefine(checkTemplateStructure),
});

export const updateSigningTemplateSchema = z.object({
  params: templateParamsSchema,
  body: templateBodyObject.partial().superRefine((body, ctx) => {
    if (Object.keys(body).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'At least one field must be provided',
      });
    }
    checkTemplateStructure(body, ctx);
  }),
});
