const express = require('express');
const router = express.Router();
const stripeController = require('../controllers/stripeController');
const { authenticate } = require('../middleware/auth');

// Create checkout session (requires auth, JSON body)
router.post('/create-checkout', authenticate, stripeController.createCheckout);

// Verify session after payment redirect
router.post('/verify-session', authenticate, stripeController.verifySession);

// Stripe webhook — receives raw body (configured in index.js)
router.post('/webhook', stripeController.handleWebhook);

module.exports = router;
