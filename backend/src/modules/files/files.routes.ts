const express = require('express');
const router = express.Router({ mergeParams: true });
const { verifyToken } = require('../../shared/middleware/auth');
const { AppError, ForbiddenError } = require('../../shared/errors/AppError');
const { requirePermission, resolveMember } = require('../lawfirms/roles/requirePermission');

// Files module adapter: reuse the storage implementation under the module path.
const storageRoutes = require('./files.storage.routes');

function injectLawFirmId(req: any, res: any, next: any) {
  const { lawFirmId } = req.params;
  if (!lawFirmId) return next();

  // Express 5: req.query is a getter that re-parses from the URL each time,
  // so simple property assignment (req.query.x = y) has no effect.
  // Override the getter so downstream handlers see lawFirmId.
  const mergedQuery = { ...req.query, lawFirmId };
  Object.defineProperty(req, 'query', {
    get() { return mergedQuery; },
    configurable: true,
  });

  // Force the firm id from the URL (not merely default it when absent). Some
  // handlers read lawFirmId body-first; letting a client-supplied body value win
  // would authorize uploads against a firm the RBAC permission gate never checked.
  if (!req.body || typeof req.body !== 'object') req.body = {};
  req.body.lawFirmId = lawFirmId;

  return next();
}

const routePermissions = new Map<string, string | string[]>([
  ['GET /list', 'files.view'],
  ['GET /list-matters', 'files.view'],
  ['GET /list-client-tasks', 'files.view'],
  ['GET /list-folder', 'files.view'],
  ['GET /refresh-url', 'files.view'],
  ['GET /location', 'files.view'],
  ['GET /download-url', 'files.view'],
  ['POST /export-jobs', 'files.view'],
  ['GET /export-job', 'files.view'],
  ['POST /export-job-cancel', 'files.view'],
  ['GET /search', 'files.view'],
  ['GET /usage', 'files.view'],
  ['POST /upload-init', 'files.upload'],
  ['POST /upload-finalize', 'files.upload'],
  ['POST /upload-cancel', 'files.upload'],
  ['PATCH /client-visibility', 'files.upload'],
  // The batched form of the line above, and it carries the SAME permission on
  // purpose: sharing a hundred files is the same act as sharing one of them.
  ['PATCH /bulk-client-visibility', 'files.upload'],
  ['POST /create-folder', 'files.manageFolders'],
  ['POST /rename', 'files.manageFolders'],
  ['POST /move', 'files.manageFolders'],
  ['POST /update-folder-color', 'files.manageFolders'],
  ['DELETE /delete', ['files.delete', 'files.manageFolders']],
  ['DELETE /delete-task-attachment', 'files.delete'],
]);

function hasPermission(member: any, permission: any) {
  if (!member) return false;
  if (member.isOwner) return true;
  return Array.isArray(member.resolvedPermissions) && member.resolvedPermissions.includes(permission);
}

function enforceFilesPermission(req: any, res: any, next: any) {
  // Normalize the path before the Map lookup: strip any trailing slash (except
  // the root) so a variant like `/list/` still resolves to the `/list` entry,
  // and LOWERCASE it, because Express routing is case-insensitive by default and
  // no router here passes `{ caseSensitive: true }`. Without that, `/Delete`
  // reached the `/delete` handler while `req.path` kept its capital, the lookup
  // missed, and the request fell through this gate entirely. Every files
  // permission was droppable by changing one letter. The Map's own keys are
  // lowercase, so lowercasing the probe is the whole fix.
  const rawPath = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
  const required = routePermissions.get(`${req.method.toUpperCase()} ${rawPath.toLowerCase()}`);

  // An unmapped path still falls through, and that is a KNOWN weakness rather
  // than a decision. Failing closed here is the right shape, and it cannot ship
  // until the Map covers every declared route: several upload and folder routes
  // are absent today, so refusing on a miss breaks them. Completing the Map and
  // flipping this line is a separate change with its own audit. Until then a
  // files route added without a Map entry carries no permission check.
  // FAIL CLOSED. A path this map does not know is refused, not waved through.
  //
  // This branch used to `return next()`, which meant a files route declared
  // without a Map entry carried no permission check and nothing said so. The Map
  // is checked against the routers it guards: files.storage.routes composes
  // upload (2 routes), browse (7), mutate (7) and download (4), and all 20 have
  // an entry. Refusing on a miss is what keeps that true, because the next route
  // added without one now fails visibly on itself instead of shipping open.
  //
  // Every route in this module is behind this gate. The one exception used to be
  // a `GET /` discovery stub in this file, which carried its own
  // `requirePermission('files.view')` and answered with a map of the sibling
  // endpoints. Commit ee814897 deleted it along with the rest of the old stack.
  if (!required) throw new ForbiddenError('Not permitted on this files route');

  if (!req.user?.uid) {
    throw new AppError('Authentication required', 401, 'AUTH_REQUIRED');
  }

  if (!req.member) {
    throw new ForbiddenError('Not a member of this firm');
  }

  const allowed = Array.isArray(required)
    ? required.some((permission) => hasPermission(req.member, permission))
    : hasPermission(req.member, required);

  if (!allowed) {
    throw new ForbiddenError();
  }

  return next();
}

router.use(injectLawFirmId, verifyToken, resolveMember(), enforceFilesPermission, storageRoutes);

// Exported for the completeness check in tests/files/filesPermissionCase.test.ts,
// which walks the composed router and asserts every gated path has an entry. The
// Map is only load-bearing if it is complete, and completeness is the one
// property neither this file nor the sub-routers can show on their own.
(router as any).routePermissions = routePermissions;

export = router;
