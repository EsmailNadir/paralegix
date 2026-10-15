const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../../shared/middleware/auth');
const { validate } = require('../../../shared/middleware/validate');
const { listFirmNotesSchema } = require('./matterNotes.validation');
const matterNotesService = require('./matterNotes.service');
import { handler } from '../../../shared/http/handler';

// GET /api/lawfirms/:lawFirmId/notes
// Firm-wide notes search. Gated on firm membership rather than a matters
// permission: the query itself narrows an ordinary member to the matters they
// are on, so a broader permission would only widen what an owner or admin
// already sees.
router.get('/',
  verifyToken,
  validate(listFirmNotesSchema),
  handler(async (req) => matterNotesService.listFirmNotes({
    lawFirmId: req.params.lawFirmId,
    userId: req.user.uid,
    query: req.query,
  })),
);

export = router;
