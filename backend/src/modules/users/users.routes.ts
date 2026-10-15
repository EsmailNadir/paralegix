const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { requireIsAdmin } = require('../../shared/middleware/requireIsAdmin');
const { validate } = require('../../shared/middleware/validate');
const { updateNameSchema } = require('./users.validation');
const { AppError } = require('../../shared/errors/AppError');
const usersService = require('./users.service');
import { handler } from '../../shared/http/handler';

// The profile picture uploads straight to storage. It used to arrive here as
// multipart and sit in the container's heap before the handler ran: one 5 MB
// picture is nothing, but this instance serves 80 concurrent requests on
// 512 MiB while also signing documents. The type and size rules did not change;
// they moved into `beginPhotoUpload` and `finishPhotoUpload`, which apply them
// to what STORAGE recorded rather than to a request buffer that no longer
// exists.

/**
 * Helper: set ETag/caching headers and handle 304 Not Modified.
 * Returns true if a 304 was sent (caller should return early).
 */
function handleETagCaching(req: any, res: any, { etag, lastModified }: any) {
  res.set({
    'Cache-Control': 'private, no-cache, max-age=0, must-revalidate',
    'ETag': etag,
    'Last-Modified': lastModified,
  });
  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return true;
  }
  return false;
}

// GET /api/users/profile (must be before /:userId to avoid matching "profile" as userId)
router.get('/users/profile',
  verifyToken,
  handler(async (req, res) => {
    const result = await usersService.getProfile({ userId: req.user.uid });
    if (handleETagCaching(req, res, result)) return;
    res.json(result.userData);
  }),
);

// GET /api/users/my-lawfirms
router.get('/users/my-lawfirms',
  verifyToken,
  handler(async (req) => usersService.getMyLawFirms({ userId: req.user.uid })),
);

// GET /api/users/my-memberships
router.get('/users/my-memberships',
  verifyToken,
  handler(async (req) => usersService.getMyMemberships({ userId: req.user.uid })),
);

// PUT /api/users/update-name
router.put('/users/update-name',
  verifyToken,
  validate(updateNameSchema),
  handler(async (req, res) => {
    const result = await usersService.updateName({
      userId: req.user.uid,
      body: req.body,
    });
    res.json(result);
  }),
);

// POST /api/users/me/photo/upload-init: mint the session the browser PUTs to.
router.post('/users/me/photo/upload-init',
  verifyToken,
  handler(async (req) => usersService.beginPhotoUpload({
    userId: req.user.uid,
    contentType: req.body?.contentType,
    fileName: req.body?.fileName,
    size: req.body?.size,
    origin: req.get('origin') || undefined,
  })),
);

// POST /api/users/me/photo/upload-finalize: verify what landed, then save it.
router.post('/users/me/photo/upload-finalize',
  verifyToken,
  handler(async (req) => usersService.finishPhotoUpload({
    userId: req.user.uid,
    objectPath: req.body?.objectPath,
  })),
);

// DELETE /api/users/me/photo
router.delete('/users/me/photo',
  verifyToken,
  handler(async (req) => usersService.deletePhoto({ userId: req.user.uid })),
);

// GET /api/users/lawfirm/:lawfirmId/users
router.get('/users/lawfirm/:lawfirmId/users',
  verifyToken,
  handler(async (req) => {
    const result = await usersService.getLawFirmUsers({
      lawFirmId: req.params.lawfirmId,
      requesterId: req.user.uid,
    });
    if (result.length === 0) {
      throw new AppError('No users found for this law firm', 404, 'NOT_FOUND');
    }
    return result;
  }),
);

// GET /api/users/ (list all users)
//
// Responds with `{ users, totalItems, truncated, ceiling }`. It used to respond
// with a bare array, which left nowhere to report that the list had been cut
// short — and this read has no WHERE and no LIMIT, so it grows with the platform.
router.get('/users/',
  verifyToken,
  requireIsAdmin,
  handler(async (req) => usersService.listAllUsers()),
);

// GET /api/users/:userId (must be last, wildcard catch)
router.get('/users/:userId',
  verifyToken,
  handler(async (req, res) => {
    const result = await usersService.getUserById({
      userId: req.params.userId,
      requesterId: req.user.uid,
    });
    if (handleETagCaching(req, res, result)) return;
    res.json(result.userData);
  }),
);

export = router;
