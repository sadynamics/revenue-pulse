import 'dotenv/config';

/**
 * Canlı App Store notification simülatörü — çalışan server'a rasgele event POST eder.
 * İmzalı JWS üretmek için Apple signing key gerektiğinden, `/webhook/test` endpoint'ini
 * kullanır ve decoded notification objesi gönderir (SKIP_VERIFICATION durumundaki davranışla
 * eşdeğer).
 *
 * Usage: npm run simulate -- --url http://localhost:3000 --interval 3000
 */

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
    return acc;
  }, [])
);

const URL = args.url || `http://localhost:${process.env.PORT || 3000}`;
const INTERVAL = parseInt(args.interval || '4000', 10);

const PRODUCTS = [
  { id: 'com.acme.pro.monthly',     price: 9990,  period: 'MONTHLY', days: 30, type: 'Auto-Renewable Subscription', group: 'pro' },
  { id: 'com.acme.pro.annual',      price: 79990, period: 'ANNUAL',  days: 365, type: 'Auto-Renewable Subscription', group: 'pro' },
  { id: 'com.acme.premium.monthly', price: 14990, period: 'MONTHLY', days: 30, type: 'Auto-Renewable Subscription', group: 'premium' },
];
const STOREFRONTS = ['USA','GBR','DEU','FRA','TUR','BRA','IND','JPN'];

const PATTERNS = [
  { type: 'SUBSCRIBED',                subtype: 'INITIAL_BUY' },
  { type: 'SUBSCRIBED',                subtype: 'INITIAL_BUY' },
  { type: 'DID_RENEW',                 subtype: null },
  { type: 'DID_RENEW',                 subtype: null },
  { type: 'DID_RENEW',                 subtype: null },
  { type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED' },
  { type: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_ENABLED' },
  { type: 'DID_FAIL_TO_RENEW',         subtype: 'GRACE_PERIOD' },
  { type: 'EXPIRED',                   subtype: 'VOLUNTARY' },
  { type: 'REFUND',                    subtype: null },
  { type: 'DID_CHANGE_RENEWAL_PREF',   subtype: 'UPGRADE' },
  { type: 'SUBSCRIBED',                subtype: 'RESUBSCRIBE' },
];

function rand(a) { return a[Math.floor(Math.random() * a.length)]; }
function uuid()  { return [8,4,4,4,12].map(n => Math.random().toString(16).slice(2, 2+n).padEnd(n,'0')).join('-'); }

async function tick() {
  const product = rand(PRODUCTS);
  const { type, subtype } = rand(PATTERNS);
  const originalTxId = 'otx_' + Math.random().toString(36).slice(2, 12);
  const appAccountToken = uuid();
  const now = Date.now();

  const payload = {
    notificationType: type,
    subtype,
    notificationUUID: uuid(),
    version: '2.0',
    signedDate: now,
    data: { appAppleId: 1234567890, bundleId: 'com.acme.app', bundleVersion: '1.0', environment: 'Production' },
    transactionInfo: {
      transactionId: 'tx_' + Math.random().toString(36).slice(2, 14),
      originalTransactionId: originalTxId,
      webOrderLineItemId: String(Date.now()),
      bundleId: 'com.acme.app',
      productId: product.id,
      subscriptionGroupIdentifier: product.group,
      purchaseDate: now,
      originalPurchaseDate: now,
      expiresDate: now + product.days * 86400000,
      quantity: 1,
      type: product.type,
      appAccountToken,
      inAppOwnershipType: 'PURCHASED',
      signedDate: now,
      environment: 'Production',
      storefront: rand(STOREFRONTS),
      storefrontId: '143441',
      price: product.price,
      currency: 'USD',
    },
    renewalInfo: {
      originalTransactionId: originalTxId,
      autoRenewProductId: product.id,
      productId: product.id,
      autoRenewStatus: type === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED' ? 0 : 1,
      renewalDate: now + product.days * 86400000,
      environment: 'Production',
      recentSubscriptionStartDate: now,
      signedDate: now,
    },
  };

  try {
    const res = await fetch(`${URL}/webhook/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    const label = `${type}${subtype ? ':' + subtype : ''}`;
    console.log(`→ ${label.padEnd(40)} ${product.id.padEnd(28)} $${(product.price/1000).toFixed(2).padStart(7)}  ${res.status} ${JSON.stringify(data)}`);
  } catch (err) {
    console.error('✗', err.message);
  }
}

console.log(`Simulating App Store notifications → ${URL}/webhook/test every ${INTERVAL}ms`);
setInterval(tick, INTERVAL);
tick();
