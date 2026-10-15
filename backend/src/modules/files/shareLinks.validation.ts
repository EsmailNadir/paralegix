import { z } from 'zod';

/** The most items one link may name. A folder counts once, whatever it holds. */
export const MAX_SHARE_LINK_ITEMS = 100;

export const createShareLinkSchema = z.object({
  body: z.object({
    // One document, the original shape.
    fileId: z.string().uuid('A file is required').optional(),
    // A selection of files and folders from the browser.
    fileIds: z.array(z.string().uuid('A file is required'))
      .min(1, 'Select at least one item to share')
      .max(MAX_SHARE_LINK_ITEMS, `Select at most ${MAX_SHARE_LINK_ITEMS} items to share at once`)
      .optional(),
    permission: z.enum(['view', 'download']).optional(),
    expiresInHours: z.coerce.number().int().min(1).max(24 * 365).optional(),
    password: z.string().min(1).max(200).optional().nullable(),
  }).refine((b) => !!b.fileId !== !!b.fileIds, { message: 'A file is required', path: ['fileId'] }),
  params: z.object({ lawFirmId: z.string() }),
});

export const listShareLinksSchema = z.object({
  query: z.object({
    // The links on one item, the original shape.
    fileId: z.string().uuid('A file is required').optional(),
    // The links on any item of a selection, comma-separated.
    fileIds: z.string()
      .transform((value) => value.split(',').map((id) => id.trim()).filter(Boolean))
      .pipe(
        z.array(z.string().uuid('A file is required'))
          .min(1, 'Select at least one item')
          .max(MAX_SHARE_LINK_ITEMS, `Select at most ${MAX_SHARE_LINK_ITEMS} items at once`),
      )
      .optional(),
  }).refine((q) => !!q.fileId !== !!q.fileIds, { message: 'A file is required', path: ['fileId'] }),
  params: z.object({ lawFirmId: z.string() }),
});

export const resolveDownloadSchema = z.object({
  body: z.object({
    password: z.string().max(200).optional(),
    // Which document to download through a multi-item link. A single-file link
    // ignores it: that link only ever serves its own document.
    fileId: z.string().uuid().optional(),
  }),
  params: z.object({ token: z.string() }),
});

export const listPublicItemsSchema = z.object({
  body: z.object({
    password: z.string().max(200).optional(),
    // The shared folder to open. Absent means the link's own items.
    folderId: z.string().uuid().optional(),
  }),
  params: z.object({ token: z.string() }),
});
