// Run: node createPromoCodes.js

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
  // Use existing coupon from Stripe dashboard
  const couponId = 'TdBheFug';
  console.log(`Using coupon: ${couponId}\n`);

  // Step 1: Deactivate all existing promo codes that conflict
  console.log('Deactivating old promotion codes...');
  let hasMore = true;
  let startingAfter = null;
  while (hasMore) {
    const path = startingAfter
      ? `/v1/promotion_codes?limit=100&active=true&starting_after=${startingAfter}`
      : '/v1/promotion_codes?limit=100&active=true';
    const list = await stripeRequest('GET', path);
    for (const pc of list.data) {
      if (/^MIG26\d{3}grab100$/i.test(pc.code)) {
        try {
          await stripeRequest('POST', `/v1/promotion_codes/${pc.id}`, { active: 'false' });
          console.log(`  Deactivated: ${pc.code} (${pc.id})`);
        } catch (err) {
          console.error(`  Failed to deactivate ${pc.code}: ${err.message}`);
        }
      }
    }
    hasMore = list.has_more;
    if (list.data.length > 0) startingAfter = list.data[list.data.length - 1].id;
  }

  // Step 2: Create 100 promo codes
  console.log('\nCreating 100 promotion codes...\n');
  let created = 0, failed = 0;

  for (let i = 1; i <= 100; i++) {
    const code = `MIG26${String(i).padStart(3, '0')}grab100`;
    try {
      await stripeRequest('POST', '/v1/promotion_codes', {
        'promotion[coupon]': couponId,
        'promotion[type]': 'coupon',
        code,
        max_redemptions: '1',
      });
      created++;
      console.log(`[${i}/100] Created: ${code}`);
    } catch (err) {
      failed++;
      console.error(`[${i}/100] FAILED: ${code} - ${err.message}`);
    }
  }

  console.log(`\nDone! Coupon: ${couponId} | Created: ${created}, Failed: ${failed}`);
}

main();
