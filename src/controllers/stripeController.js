const axios = require('axios');
const config = require('../config');
const prisma = require('../config/database');

const PLANS = {
  basic: { name: 'Basic Plan', amount: 4900, currency: 'usd', priceId: 'price_1TBSV197AKaR9zY1qExJaDld' },
  pro: { name: 'Pro Plan', amount: 19900, currency: 'usd', priceId: 'price_1TBSV297AKaR9zY1nPJRTIdr' },
  ultra: { name: 'Ultra Plan', amount: 249900, currency: 'usd', priceId: 'price_1TBSV297AKaR9zY1dzaeDR0Y' },
};

const STATIC_ALLOWED_FRONTEND_ORIGINS = [
  config.frontendUrl,
  'https://www.innogarage.ai',
  'https://innogarage.ai',
  'https://maverickproject-finalise-1.vercel.app',
].filter(Boolean);

const isLocalDevOrigin = (origin = '') => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
const isVercelOrigin = (origin = '') => /^https:\/\/[a-zA-Z0-9-]+(\.vercel\.app)$/.test(origin);

const normalizeOrigin = (value = '') => {
  try {
    return new URL(value).origin;
  } catch {
    return '';
  }
};

const isAllowedFrontendOrigin = (origin) => {
  if (!origin) return false;
  return STATIC_ALLOWED_FRONTEND_ORIGINS.includes(origin) || isLocalDevOrigin(origin) || isVercelOrigin(origin);
};

const getCheckoutFrontendBaseUrl = (req) => {
  const requestedOrigin = normalizeOrigin(
    req.body?.redirectOrigin || req.get('origin') || req.get('referer') || ''
  );

  if (requestedOrigin && isAllowedFrontendOrigin(requestedOrigin)) {
    return requestedOrigin;
  }

  return normalizeOrigin(config.frontendUrl) || 'http://localhost:5173';
};

// Create a Stripe Checkout Session using the REST API directly (no stripe npm package needed)
exports.createCheckout = async (req, res) => {
  try {
    const { plan } = req.body;
    const userEmail = req.user.email;

    if (!plan || !PLANS[plan]) {
      return res.status(400).json({ message: 'Invalid plan. Choose basic, pro, or ultra.' });
    }

    const planData = PLANS[plan];
    const secretKey = config.stripe.secretKey;
    const frontendBaseUrl = getCheckoutFrontendBaseUrl(req);

    if (!secretKey) {
      return res.status(500).json({ message: 'Stripe secret key not configured' });
    }

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('customer_email', userEmail);
    params.append('metadata[plan]', plan);
    params.append('metadata[userId]', req.user.id);
    params.append('line_items[0][price]', planData.priceId);
    params.append('line_items[0][quantity]', 1);
    params.append('allow_promotion_codes', 'true');
    params.append('success_url', `${frontendBaseUrl}/dashboard?upgraded=true`);
    params.append('cancel_url', `${frontendBaseUrl}/dashboard`);

    const response = await axios.post(
      'https://api.stripe.com/v1/checkout/sessions',
      params.toString(),
      {
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    // Save session ID so we can verify it after payment
    await prisma.user.update({
      where: { id: req.user.id },
      data: { stripeSessionId: response.data.id },
    });

    res.json({ url: response.data.url });
  } catch (err) {
    console.error('Stripe create checkout error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Failed to create checkout session' });
  }
};

// Verify the latest checkout session and update plan after payment redirect
exports.verifySession = async (req, res) => {
  try {
    const secretKey = config.stripe.secretKey;
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    if (!user?.stripeSessionId) {
      console.log('Verify session: No stripeSessionId for user', req.user.id);
      return res.status(400).json({ message: 'No checkout session found' });
    }

    console.log(`Verify session: Checking session ${user.stripeSessionId} for user ${user.email}`);

    // Fetch session from Stripe
    const { data: session } = await axios.get(
      `https://api.stripe.com/v1/checkout/sessions/${user.stripeSessionId}`,
      {
        headers: { 'Authorization': `Bearer ${secretKey}` },
      }
    );

    console.log(`Verify session: payment_status=${session.payment_status}, metadata=`, session.metadata);

    if (session.payment_status === 'paid') {
      const plan = session.metadata?.plan;
      if (plan) {
        const updateData = {
          subscriptionPlan: plan,
          subscriptionStatus: 'active',
          subscriptionStart: new Date(),
        };

        // Auto-activate student when they pay for pro or ultra
        if (plan === 'pro' || plan === 'ultra') {
          updateData.status = 'ACTIVE';
          updateData.isActive = true;
        }

        await prisma.user.update({
          where: { id: req.user.id },
          data: updateData,
        });
        console.log(`Stripe verify: Updated user ${user.email} to plan: ${plan}`);
        return res.json({ success: true, plan });
      } else {
        console.log('Verify session: Payment succeeded but no plan in metadata');
      }
    }

    res.json({ success: false, status: session.payment_status });
  } catch (err) {
    console.error('Stripe verify session error:', err.response?.data || err.message);
    res.status(500).json({ message: 'Failed to verify session' });
  }
};

// Webhook handler — works without stripe npm package in dev mode (no signature verification)
exports.handleWebhook = async (req, res) => {
  let event;
  try {
    // In dev mode without webhook secret, just parse the raw JSON body
    event = JSON.parse(req.body.toString());
  } catch (err) {
    console.error('Stripe webhook parse error:', err.message);
    return res.status(400).json({ error: 'Invalid webhook payload' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_details?.email || session.customer_email;
    const plan = session.metadata?.plan;

    if (!customerEmail) {
      console.warn('Stripe webhook: no customer email found in session');
      return res.json({ received: true });
    }

    if (!plan) {
      console.warn('Stripe webhook: no plan in session metadata');
      return res.json({ received: true });
    }

    try {
      const user = await prisma.user.findUnique({ where: { email: customerEmail } });
      if (user) {
        const updateData = {
          subscriptionPlan: plan,
          subscriptionStatus: 'active',
          subscriptionStart: new Date(),
          stripeSessionId: session.id,
        };

        // Auto-activate student when they pay for pro or ultra
        if ((plan === 'pro' || plan === 'ultra') && user.role === 'STUDENT') {
          updateData.status = 'ACTIVE';
          updateData.isActive = true;
        }

        await prisma.user.update({
          where: { email: customerEmail },
          data: updateData,
        });
        console.log(`Stripe: Updated user ${customerEmail} to plan: ${plan}`);
      } else {
        console.warn(`Stripe webhook: no user found with email ${customerEmail}`);
      }
    } catch (err) {
      console.error('Stripe webhook DB error:', err.message);
    }
  }

  res.json({ received: true });
};
