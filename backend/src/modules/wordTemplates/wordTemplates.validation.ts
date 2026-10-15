import { z } from 'zod';

// Request shapes for the Word-first template routes. The bracket-edit and
// leftover payloads stay loosely typed here on purpose: the service checks each
// edit itself so a malformed one is refused with the exact sentence the review
// dialog shows (for example "Invalid field name: ..."), not a schema path.

export const UPLOAD_PURPOSES = ['source', 'asset', 'convert'] as const;
export const DUPLICATE_STRATEGIES = ['copy', 'replace'] as const;
export const FILL_FORMATS = ['docx', 'pdf'] as const;
export const EXPORT_FORMATS = ['pdf', 'docx', 'txt'] as const;

const params = z.object({ lawFirmId: z.string() });
const templateParams = z.object({ lawFirmId: z.string(), templateId: z.string() });

const fileName = z.string().trim().min(1, 'A file name is required.').max(255);
const objectPath = z.string().min(1, 'No file uploaded.').max(1024);
const templateName = z.string().max(500).optional();

// One row of a repeating section: column name to value.
const valueMap = z.record(z.string(), z.string());

export const createWordTemplateSchema = z.object({
  params,
  body: z.object({
    name: z.string().max(500),
    html: z.string(),
  }),
});

export const updateWordTemplateSchema = z.object({
  params: templateParams,
  body: z.object({
    name: z.string().max(500),
    html: z.string(),
  }),
});

export const renameWordTemplateSchema = z.object({
  params: templateParams,
  body: z.object({ name: z.string().max(500) }),
});

export const uploadInitSchema = z.object({
  params,
  body: z.object({
    fileName,
    contentType: z.string().max(200).optional(),
    size: z.coerce.number().int().nonnegative().optional(),
    purpose: z.enum(UPLOAD_PURPOSES),
    templateId: z.string().optional(),
  }),
});

export const settledUploadSchema = z.object({
  params,
  body: z.object({ objectPath, fileName }),
});

export const commitSchema = z.object({
  params,
  body: z.object({
    objectPath,
    fileName,
    name: templateName,
    edits: z.unknown().optional(),
    duplicateStrategy: z.enum(DUPLICATE_STRATEGIES).optional().nullable(),
    acknowledgedLeftovers: z.array(z.string().max(1000)).max(1000).optional(),
  }),
});

export const uploadDocxSchema = z.object({
  params,
  body: z.object({
    objectPath,
    fileName,
    name: templateName,
    duplicateStrategy: z.enum(DUPLICATE_STRATEGIES).optional().nullable(),
    acknowledgedLeftovers: z.array(z.string().max(1000)).max(1000).optional(),
  }),
});

export const replaceSourceSchema = z.object({
  params: templateParams,
  body: z.object({
    objectPath,
    fileName,
    acknowledgedLeftovers: z.array(z.string().max(1000)).max(1000).optional(),
  }),
});

export const assetFinalizeSchema = z.object({
  params: templateParams,
  body: z.object({ objectPath, fileName }),
});

export const fillDocxSchema = z.object({
  params: templateParams,
  body: z.object({
    values: valueMap.optional(),
    repeaterValues: z.record(z.string(), z.array(valueMap)).optional(),
    fileName: z.string().max(500).optional(),
    format: z.enum(FILL_FORMATS).optional(),
  }),
});

export const fillPdfSchema = z.object({
  params: templateParams,
  body: z.object({
    values: valueMap.optional(),
    fileName: z.string().max(500).optional(),
  }),
});

export const exportSchema = z.object({
  params,
  body: z.object({
    html: z.string({ error: 'No HTML provided.' }).min(1, 'No HTML provided.'),
    format: z.enum(EXPORT_FORMATS).optional(),
    templateId: z.string().optional(),
  }),
});

export const documentContextSchema = z.object({
  params,
  query: z.object({
    matterId: z.string().optional(),
    clientId: z.string().optional(),
  }).refine((q) => Boolean(q.matterId || q.clientId), { message: 'Pick a matter or a client.' }),
});
