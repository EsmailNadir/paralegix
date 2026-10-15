/**
 * The storage router: the `/api/lawfirms/:lawFirmId/files/*` endpoints, grouped
 * by what they do to the bucket.
 *
 * This file was one 3,600-line module in which every route re-derived its own
 * scope prefix and authorization. That work now lives in `files.scope.js`
 * (who may address which prefix), `files.storage.js` (the GCS primitives and the
 * guards around them) and `files.readers.js` (every read of the file tree), and
 * the routes below are grouped by verb rather than piled in one file.
 *
 * Mount order is flat — no path segment distinguishes the groups — so each
 * router simply passes through anything it does not define. Permissions are
 * applied upstream, per endpoint, in `files.routes.js`.
 */

const express = require('express');

const uploadRoutes = require('./files.upload.routes');
const browseRoutes = require('./files.browse.routes');
const mutateRoutes = require('./files.mutate.routes');
const downloadRoutes = require('./files.download.routes');
const { assertObjectPathReadAccess } = require('./files.scope');

const router = express.Router();

router.use(uploadRoutes);
router.use(browseRoutes);
router.use(mutateRoutes);
router.use(downloadRoutes);

export = Object.assign(router, { assertObjectPathReadAccess });
