// Setup script: Creates Stripe products, prices, unrestricted coupon, and 100 promo codes
// Run: node setupStripe.js

require('dotenv').config();
const https = require('https');

const SECRET_KEY = process.env.STRIPE_SECRET_KEY;

function stripeRequest(method, path, params) {
  return new Promise((resolve, reject) => {
    const body = params ? new URLSearchParams(params).toString() : '';
    const options = {
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        if (res.statusCode === 200) resolve(parsed);
        else reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  // ── Step 1: Create Products and Prices ──
  console.log('=== Creating Stripe Products & Prices ===\n');

  const plans = [
    { key: 'basic', name: 'Basic Plan', amount: 4900 },
    { key: 'pro', name: 'Pro Plan', amount: 19900 },
    { key: 'ultra', name: 'Ultra Plan', amount: 249900 },
  ];

  const priceIds = {};

  for (const plan of plans) {
    // Create product
    const product = await stripeRequest('POST', '/v1/products', {
      name: plan.name,
      'metadata[plan_key]': plan.key,
    });
    console.log(`Product created: ${product.name} (${product.id})`);

    // Create one-time price
    const price = await stripeRequest('POST', '/v1/prices', {
      product: product.id,
      unit_amount: String(plan.amount),
      currency: 'usd',
    });
    console.log(`Price created: $${plan.amount / 100} (${price.id})\n`);
    priceIds[plan.key] = price.id;
  }

  // ── Step 2: Create unrestricted coupon ──
  console.log('=== Creating Unrestricted Coupon ===\n');

  const coupon = await stripeRequest('POST', '/v1/coupons', {
    percent_off: '100',
    duration: 'once',
    name: 'MIG Grab 100% Off',
  });
  console.log(`Coupon created: ${coupon.name} (${coupon.id}) - NO product restrictions\n`);

  // ── Step 3: Deactivate old promo codes ──
  console.log('=== Deactivating Old Promo Codes ===\n');
  let hasMore = true;
  let startingAfter = null;
  let deactivated = 0;
  while (hasMore) {
    const path = startingAfter
      ? `/v1/promotion_codes?limit=100&active=true&starting_after=${startingAfter}`
      : '/v1/promotion_codes?limit=100&active=true';
    const list = await stripeRequest('GET', path);
    for (const pc of list.data) {
      if (/^MIG26\d{3}grab100$/i.test(pc.code)) {
        try {
          await stripeRequest('POST', `/v1/promotion_codes/${pc.id}`, { active: 'false' });
          deactivated++;
        } catch (err) { /* ignore */ }
      }
    }
    hasMore = list.has_more;
    if (list.data.length > 0) startingAfter = list.data[list.data.length - 1].id;
  }
  console.log(`Deactivated ${deactivated} old codes\n`);

  // ── Step 4: Create 100 new promo codes ──
  console.log('=== Creating 100 Promotion Codes ===\n');
  let created = 0, failed = 0;

  for (let i = 1; i <= 100; i++) {
    const code = `MIG26${String(i).padStart(3, '0')}grab100`;
    try {
      await stripeRequest('POST', '/v1/promotion_codes', {
        'promotion[coupon]': coupon.id,
        'promotion[type]': 'coupon',
        code,
        max_redemptions: '1',
      });
      created++;
      if (i % 10 === 0) console.log(`  [${i}/100] created...`);
    } catch (err) {
      failed++;
      console.error(`  [${i}/100] FAILED: ${code} - ${err.message}`);
    }
  }

  console.log(`\nPromo codes: ${created} created, ${failed} failed\n`);

  // ── Summary ──
  console.log('=== SUMMARY - Save these IDs! ===\n');
  console.log('Price IDs (put in stripeController.js):');
  for (const [key, id] of Object.entries(priceIds)) {
    console.log(`  ${key}: '${id}'`);
  }
  console.log(`\nCoupon ID: ${coupon.id}`);
  console.log('\nDone!');
}

main().catch(err => console.error('Fatal:', err.message));
