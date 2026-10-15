// PUBLIC (unauthenticated) routes for the secure payment link. The token in
// the URL is the sole credential; there is no verifyToken. Rate-limited by IP
// to blunt token guessing, like the public share and signing routes.
import { z } from 'zod';
import { handler } from '../../shared/http/handler';
import { cardCompleteSchema, cardConfirmSchema, cardQuoteSchema } from './stripe.validation';

const express = require('express');
const router = express.Router({ mergeParams: true });
const { publicPayLimiter } = require('../../shared/middleware/rateLimiters');
const { validate } = require('../../shared/middleware/validate');
const service = require('./payLink.service');

const startCheckoutSchema = z.object({
  body: z.object({ method: z.enum(['card', 'bank']) }).strict(),
});

// GET /api/pay/:token (the invoice and what each method costs)
router.get('/:token', publicPayLimiter, handler(async (req) => service.getPayPage(req.params.token)));

// POST /api/pay/:token/checkout (start Stripe checkout for the chosen method)
router.post('/:token/checkout', publicPayLimiter, validate(startCheckoutSchema),
  handler(async (req) => service.startPayLinkCheckout(req.params.token, req.body.method)));

// POST /api/pay/:token/card/quote (what the card the client entered pays)
router.post('/:token/card/quote', publicPayLimiter, validate(cardQuoteSchema),
  handler(async (req) => service.quotePayLinkCard(req.params.token, req.body.confirmationTokenId)));

// POST /api/pay/:token/card/confirm (charge the card for the total the client was shown)
router.post('/:token/card/confirm', publicPayLimiter, validate(cardConfirmSchema),
  handler(async (req) => service.confirmPayLinkCard(req.params.token, req.body.confirmationTokenId, req.body.expectedTotalCents)));

// POST /api/pay/:token/card/complete (record the payment after bank verification)
router.post('/:token/card/complete', publicPayLimiter, validate(cardCompleteSchema),
  handler(async (req) => service.completePayLinkCard(req.params.token, req.body.paymentIntentId)));

export = router;
