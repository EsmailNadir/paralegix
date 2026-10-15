import { z } from 'zod';

export const createFolderSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100),
    color: z.string().max(20).optional().nullable(),
    parentFolderId: z.string().optional().nullable(),
  }),
});

export const updateFolderSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100).optional(),
    color: z.string().max(20).optional().nullable(),
    parentFolderId: z.string().optional().nullable(),
  }),
});
