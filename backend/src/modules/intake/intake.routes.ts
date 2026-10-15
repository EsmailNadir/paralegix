const express = require('express');
const router = express.Router({ mergeParams: true });

const { intakeReadLimiter, intakeGateLimiter, intakeSubmitLimiter } = require('../../shared/middleware/rateLimiters');
const { validate } = require('../../shared/middleware/validate');
const { getIntakeFormSchema, verifyAccessCodeSchema, submitIntakeSchema } = require('./intake.validation');
const intakeService = require('./intake.service');
import { handler } from '../../shared/http/handler';

// Public intake routes — no verifyToken. Modeled on /api/signing.

// GET /api/intake/:token
router.get('/:token', intakeReadLimiter, validate(getIntakeFormSchema), handler(async (req) => intakeService.getIntakeForm(req.params.token)));

// POST /api/intake/:token/verify-access-code
//
// `intakeGateLimiter`, not `intakeReadLimiter`: the gate is keyed on the token
// so guesses at one form share one bucket however many addresses they come
// from, while the read above stays keyed on the address so nobody can spend a
// public form's allowance and take its page offline. See the two limiters in
// shared/middleware/rateLimiters.ts for why they cannot be one.
router.post('/:token/verify-access-code', intakeGateLimiter, validate(verifyAccessCodeSchema), handler(async (req) => intakeService.verifyAccessCode({
  token: req.params.token,
  code: req.body?.code,
})));

// POST /api/intake/:token/submit
router.post('/:token/submit', intakeSubmitLimiter, validate(submitIntakeSchema), handler(async (req) => {
  const submission = await intakeService.submitIntake({
    token: req.params.token,
    fieldValues: req.body?.fieldValues,
    accessCode: req.body?.accessCode,
    ip: req.ip,
  });
  return { id: submission.id };
}, 201));

export = router;
