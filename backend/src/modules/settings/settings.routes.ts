const express = require('express');
const router = express.Router({ mergeParams: true });

const { verifyToken } = require('../../shared/middleware/auth');
const { validate } = require('../../shared/middleware/validate');
const { requirePermission } = require('../lawfirms/roles/requirePermission');
const {
  updateUserSettingsSchema,
  updateFirmSettingsSchema,
  updateClientSettingsSchema,
  updateFirmFeatureSchema,
  lockSettingSchema,
  unlockSettingSchema,
} = require('./settings.validation');
const settingsService = require('./settings.service');
import { handler } from '../../shared/http/handler';

// ----- User settings (current user) -----

// GET /api/settings/user
router.get('/settings/user',
  verifyToken,
  handler(async (req) => {
    const lawFirmId = req.query.lawFirmId;
    const userId = req.user.uid;
    const settings = await settingsService.getUserSettings({ lawFirmId, userId });
    return { preferences: settings };
  }),
);

// POST /api/settings/user
router.post('/settings/user',
  verifyToken,
  validate(updateUserSettingsSchema),
  handler(async (req) => {
    const lawFirmId = req.query.lawFirmId;
    const userId = req.user.uid;
    const { preferences } = req.body;
    const result = await settingsService.updateUserSettings({ lawFirmId, userId, preferences });
    return result;
  }),
);

// ----- Firm settings -----

// GET /api/lawfirms/:lawFirmId/settings/firm
router.get('/lawfirms/:lawFirmId/settings/firm',
  verifyToken,
  requirePermission('settings.viewFirm'),
  handler(async (req) => {
    const lawFirmId = req.params.lawFirmId;
    const result = await settingsService.getFirmSettings({ lawFirmId });
    return { settings: result };
  }),
);

// PUT /api/lawfirms/:lawFirmId/settings/firm
router.put('/lawfirms/:lawFirmId/settings/firm',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updateFirmSettingsSchema),
  handler(async (req) => {
    const lawFirmId = req.params.lawFirmId;
    const { settings } = req.body;
    const result = await settingsService.updateFirmSettings({ lawFirmId, settings });
    return result;
  }),
);

// PUT /api/lawfirms/:lawFirmId/settings/features/:feature
//
// Switch one plan-allowed feature off (or back on) for the firm. Separate from
// the firm-settings PUT above, which deliberately drops `features`: a feature
// switch hides an entire area of the product, so it gets an explicitly
// allowlisted path rather than riding along in a free-form preferences write.
// `settings.manageFirm` matches the PUT above, so whoever already edits firm
// settings can do this.
router.put('/lawfirms/:lawFirmId/settings/features/:feature',
  verifyToken,
  requirePermission('settings.manageFirm'),
  validate(updateFirmFeatureSchema),
  handler(async (req) => settingsService.setFirmFeature({
    lawFirmId: req.params.lawFirmId,
    feature: req.params.feature,
    enabled: req.body.enabled,
  })),
);

// POST /api/lawfirms/:lawFirmId/settings/lock
router.post('/lawfirms/:lawFirmId/settings/lock',
  verifyToken,
  requirePermission('settings.manageLocked'),
  validate(lockSettingSchema),
  handler(async (req) => {
    const lawFirmId = req.params.lawFirmId;
    const { key, value } = req.body;
    const result = await settingsService.lockSetting({ lawFirmId, key, value });
    return result;
  }),
);

// POST /api/lawfirms/:lawFirmId/settings/unlock
// Clears an admin lock entirely (removes the key from locks + lockedSettings),
// unlike the lock route which sets locks.<key>=true.
router.post('/lawfirms/:lawFirmId/settings/unlock',
  verifyToken,
  requirePermission('settings.manageLocked'),
  validate(unlockSettingSchema),
  handler(async (req) => {
    const lawFirmId = req.params.lawFirmId;
    const { key } = req.body;
    const result = await settingsService.unlockSetting({ lawFirmId, key });
    return result;
  }),
);

// ----- Client settings -----

// GET /api/lawfirms/:lawFirmId/clients/:clientId/settings
router.get('/lawfirms/:lawFirmId/clients/:clientId/settings',
  verifyToken,
  requirePermission('clients.view'),
  handler(async (req) => {
    const { lawFirmId, clientId } = req.params;
    const settings = await settingsService.getClientSettings({ lawFirmId, clientId });
    return { settings };
  }),
);

// PUT /api/lawfirms/:lawFirmId/clients/:clientId/settings
router.put('/lawfirms/:lawFirmId/clients/:clientId/settings',
  verifyToken,
  requirePermission('clients.manage'),
  validate(updateClientSettingsSchema),
  handler(async (req) => {
    const { lawFirmId, clientId } = req.params;
    const { settings } = req.body;
    const result = await settingsService.updateClientSettings({ lawFirmId, clientId, settings });
    return result;
  }),
);

export = router;
