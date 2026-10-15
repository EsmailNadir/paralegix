/**
 * The notes REST surface, as one router per parent entity.
 *
 * Matter, task and client notes expose the same fourteen endpoints over the
 * same shared notes engine: list, read, versions, create, update, pin, retract,
 * three time-entry routes, and four reply routes. They were three hand-kept
 * copies that differed only in the `:param` segment and the permission each
 * route demands, which meant a fix to one (or a new route on one) silently left
 * the other two behind.
 *
 * The caller supplies the param name, the two services, its validation module,
 * and one permission per route, and gets a router back. Anything an entity has
 * on top of the shared set (the matter module's task/file links and client
 * update) is mounted by that module onto the returned router.
 */

const express = require('express');

const { verifyToken } = require('../middleware/auth');
const { requireTimezone } = require('../middleware/timezone');
const { validate } = require('../middleware/validate');
const { requirePermission } = require('../../modules/lawfirms/roles/requirePermission');

/** One permission string per route, so an entity keeps its own access rules. */
export interface NotesRouterPermissions {
  /** list, read, versions, and list replies. */
  view: string;
  /** create, update, and pin a note. */
  write: string;
  /** retract a note. */
  retract: string;
  /** the three time-entry routes. */
  time: string;
  /** create, update, and retract a reply. */
  reply: string;
}

export interface NotesRouterOptions {
  /** The parent's route segment, without the colon (e.g. `matterId`). */
  paramName: string;
  notesService: any;
  repliesService: any;
  /** The module's own `*.validation` exports. */
  schemas: any;
  permissions: NotesRouterPermissions;
}

export function createNotesRouter({
  paramName,
  notesService,
  repliesService,
  schemas,
  permissions,
}: NotesRouterOptions) {
  const router = express.Router({ mergeParams: true });
  const base = `/:${paramName}/notes`;

  /** The identifiers every handler starts from, keyed by this entity's param. */
  const scope = (req: any) => ({
    lawFirmId: req.params.lawFirmId,
    [paramName]: req.params[paramName],
    userId: req.user.uid,
    timeZone: req.tz,
  });

  router.get(base,
    verifyToken,
    requirePermission(permissions.view),
    validate(schemas.listNotesSchema),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.listNotes({ ...scope(req), query: req.query }));
    },
  );

  router.get(`${base}/:noteId`,
    verifyToken,
    requirePermission(permissions.view),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.getNoteDetail({ ...scope(req), noteId: req.params.noteId }));
    },
  );

  router.get(`${base}/:noteId/versions`,
    verifyToken,
    requirePermission(permissions.view),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.listNoteVersions({ ...scope(req), noteId: req.params.noteId }));
    },
  );

  router.post(base,
    verifyToken,
    requirePermission(permissions.write),
    requireTimezone,
    validate(schemas.addNoteSchema),
    async (req: any, res: any) => {
      res.status(201).json(await notesService.addNote({ ...scope(req), body: req.body }));
    },
  );

  router.put(`${base}/:noteId`,
    verifyToken,
    requirePermission(permissions.write),
    requireTimezone,
    validate(schemas.updateNoteSchema),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.updateNote({
        ...scope(req), noteId: req.params.noteId, body: req.body,
      }));
    },
  );

  router.put(`${base}/:noteId/pin`,
    verifyToken,
    requirePermission(permissions.write),
    validate(schemas.pinNoteSchema),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.setNotePinned({
        ...scope(req), noteId: req.params.noteId, pinned: req.body.pinned,
      }));
    },
  );

  // Retracts rather than deletes: a note is a record of work performed, and its
  // time entries and links point at it.
  router.delete(`${base}/:noteId`,
    verifyToken,
    requirePermission(permissions.retract),
    requireTimezone,
    validate(schemas.retractNoteSchema),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.retractNote({
        ...scope(req), noteId: req.params.noteId, reason: req.body?.reason,
      }));
    },
  );

  router.post(`${base}/:noteId/time`,
    verifyToken,
    requirePermission(permissions.time),
    requireTimezone,
    validate(schemas.addTimeToNoteSchema),
    async (req: any, res: any) => {
      res.status(201).json(await notesService.addTimeToNote({
        ...scope(req), noteId: req.params.noteId, body: req.body,
      }));
    },
  );

  router.put(`${base}/:noteId/time/:timeEntryId`,
    verifyToken,
    requirePermission(permissions.time),
    requireTimezone,
    validate(schemas.updateNoteTimeEntrySchema),
    async (req: any, res: any) => {
      res.status(200).json(await notesService.updateNoteTimeEntry({
        ...scope(req),
        noteId: req.params.noteId,
        timeEntryId: req.params.timeEntryId,
        body: req.body,
      }));
    },
  );

  router.delete(`${base}/:noteId/time/:timeEntryId`,
    verifyToken,
    requirePermission(permissions.time),
    requireTimezone,
    async (req: any, res: any) => {
      res.status(200).json(await notesService.removeNoteTimeEntry({
        ...scope(req), noteId: req.params.noteId, timeEntryId: req.params.timeEntryId,
      }));
    },
  );

  router.get(`${base}/:noteId/replies`,
    verifyToken,
    requirePermission(permissions.view),
    async (req: any, res: any) => {
      res.status(200).json(await repliesService.listReplies({ ...scope(req), noteId: req.params.noteId }));
    },
  );

  router.post(`${base}/:noteId/replies`,
    verifyToken,
    requirePermission(permissions.reply),
    validate(schemas.addReplySchema),
    async (req: any, res: any) => {
      res.status(201).json(await repliesService.addReply({
        ...scope(req), noteId: req.params.noteId, body: req.body,
      }));
    },
  );

  router.put(`${base}/:noteId/replies/:replyId`,
    verifyToken,
    requirePermission(permissions.reply),
    validate(schemas.updateReplySchema),
    async (req: any, res: any) => {
      res.status(200).json(await repliesService.updateReply({
        ...scope(req), noteId: req.params.noteId, replyId: req.params.replyId, body: req.body,
      }));
    },
  );

  // Retracts rather than deletes, matching the note itself.
  router.delete(`${base}/:noteId/replies/:replyId`,
    verifyToken,
    requirePermission(permissions.reply),
    validate(schemas.retractReplySchema),
    async (req: any, res: any) => {
      res.status(200).json(await repliesService.retractReply({
        ...scope(req),
        noteId: req.params.noteId,
        replyId: req.params.replyId,
        reason: req.body?.reason,
      }));
    },
  );

  return router;
}
