const express = require('express');
const router = express.Router();
const admissionRoutes = require('./signingAdmission.routes');
const publicRoutes = require('./signingPublic.routes');
const artifactRoutes = require('./signingArtifacts.routes');
import { cleanupExpiredUploads, cleanupExpiredSessions, sweepSettledWorkspaces, recoverStuckFinalizations, archiveCertificateAfterCompletion } from './signingRouteSupport';

// Admission paths must precede the public single-token route.
router.use(admissionRoutes);
router.use(publicRoutes);
router.use(artifactRoutes);

export = Object.assign(router, {
  cleanupExpiredUploads,
  cleanupExpiredSessions,
  sweepSettledWorkspaces,
  recoverStuckFinalizations,
  archiveCertificateAfterCompletion,
});
