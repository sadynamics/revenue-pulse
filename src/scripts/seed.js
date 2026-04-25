import 'dotenv/config';
import { processEvent } from '../services/events.js';
import { mapNotification } from '../services/appstore.js';
import { reloadApps, getDefaultApp } from '../services/apps.js';

// Ensure apps registry is populated; seeded events are tagged with the default
// app so they show up under the configured app in the UI.
reloadApps();
const SEED_APP = getDefaultApp() || {
  id: 'demo',
  name: 'Demo',
  bundle_id: 'com.acme.app',
  environment: 'Production',
};
console.log(`Seeding under app="${SEED_APP.id}" (bundle_id=${SEED_APP.bundle_id})`);

/**
 * 90 günlük App Store Server Notifications V2 demo data üretir.
 * Gerçek imzalı JWS üretmek gerekmediği için `mapNotification` çağırıp generic event'e
 * çeviriyor ve direkt DB'ye yazıyoruz (verification endpoint'te zaten test ediliyor).
 */

const PRODUCTS = [
  { id: 'com.acme.pro.monthly',     price: 9990,   period: 'MONTHLY', days: 30,  type: 'Auto-Renewable Subscription', group: 'pro' },
  { id: 'com.acme.pro.annual',      price: 79990,  period: 'ANNUAL',  days: 365, type: 'Auto-Renewable Subscription', group: 'pro' },
  { id: 'com.acme.pro.weekly',      price: 4990,   period: 'WEEKLY',  days: 7,   type: 'Auto-Renewable Subscription', group: 'pro' },
  { id: 'com.acme.premium.monthly', price: 14990,  period: 'MONTHLY', days: 30,  type: 'Auto-Renewable Subscription', group: 'premium' },
  { id: 'com.acme.lifetime',        price: 199990, period: 'LIFETIME', days: null, type: 'Non-Consumable',             group: null },
];

const STOREFRONTS = ['USA','GBR','DEU','FRA','TUR','BRA','IND','JPN','CAN','AUS','MEX','NLD','SWE','ESP','ITA','POL','SGP','ARE'];

function rand(a) { return a[Math.floor(Math.random() * a.length)]; }
function uuid()  { return [8,4,4,4,12].map(n => Math.random().toString(16).slice(2, 2+n).padEnd(n,'0')).join('-'); }

function makeNotification({ notificationType, subtype, product, originalTxId, appAccountToken, timestamp, overrides = {} }) {
  const txId = 'tx_' + Math.random().toString(36).slice(2, 14);
  const weOrderId = String(10_000_000_000_000 + Math.floor(Math.random() * 1e12));
  const tx = {
    transactionId: txId,
    originalTransactionId: originalTxId,
    webOrderLineItemId: weOrderId,
    bundleId: SEED_APP.bundle_id,
    productId: product.id,
    subscriptionGroupIdentifier: product.group,
    purchaseDate: timestamp,
    originalPurchaseDate: timestamp,
    expiresDate: product.days ? timestamp + product.days * 86400000 : null,
    quantity: 1,
    type: product.type,
    appAccountToken: appAccountToken,
    inAppOwnershipType: 'PURCHASED',
    signedDate: timestamp,
    environment: 'Production',
    transactionReason: notificationType === 'DID_RENEW' ? 'RENEWAL' : 'PURCHASE',
    storefront: rand(STOREFRONTS),
    storefrontId: '143441',
    price: product.price,
    currency: 'USD',
    ...overrides.transaction,
  };
  const renewalInfo = product.days ? {
    originalTransactionId: originalTxId,
    autoRenewProductId: product.id,
    productId: product.id,
    autoRenewStatus: overrides.autoRenewStatus ?? 1,
    renewalDate: tx.expiresDate,
    environment: 'Production',
    recentSubscriptionStartDate: timestamp,
    signedDate: timestamp,
    ...overrides.renewalInfo,
  } : null;

  return {
    notificationType,
    subtype: subtype || null,
    notificationUUID: uuid(),
    version: '2.0',
    signedDate: timestamp,
    data: {
      appAppleId: 1234567890,
      bundleId: SEED_APP.bundle_id,
      bundleVersion: '1.0',
      environment: 'Production',
    },
    transactionInfo: tx,
    renewalInfo,
  };
}

function ingestApple(notification) {
  const events = mapNotification(notification, { appId: SEED_APP.id });
  for (const ev of events) processEvent(ev);
}

const DAY = 86400000;
const now = Date.now();

console.log('Seeding 90 days of App Store notifications…');

let count = 0;
for (let daysAgo = 90; daysAgo >= 0; daysAgo--) {
  const dayStart = now - daysAgo * DAY;
  const newCount = 3 + Math.floor(Math.random() * 10);

  for (let i = 0; i < newCount; i++) {
    const at = dayStart + Math.floor(Math.random() * DAY);
    const product = rand(PRODUCTS);
    const originalTxId = 'otx_' + Math.random().toString(36).slice(2, 12);
    const appAccountToken = uuid();

    // %20 ihtimalle intro FREE_TRIAL ile başla
    const startsWithTrial = product.days && Math.random() < 0.2;

    if (startsWithTrial) {
      ingestApple(makeNotification({
        notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY',
        product, originalTxId, appAccountToken, timestamp: at,
        overrides: {
          transaction: {
            offerType: 1, offerDiscountType: 'FREE_TRIAL',
            price: 0,
            purchaseDate: at,
            expiresDate: at + 7 * DAY,
          },
        },
      }));
      count++;

      const trialEnd = at + 7 * DAY;
      if (trialEnd < now) {
        if (Math.random() < 0.6) {
          // Trial'dan dönüşür — DID_RENEW (real price, offerType yok)
          ingestApple(makeNotification({
            notificationType: 'DID_RENEW', product, originalTxId, appAccountToken, timestamp: trialEnd,
          }));
          count++;
        } else {
          // Trial biter, convert olmaz → DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED + EXPIRED
          ingestApple(makeNotification({
            notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED',
            product, originalTxId, appAccountToken, timestamp: trialEnd - DAY,
          }));
          ingestApple(makeNotification({
            notificationType: 'EXPIRED', subtype: 'VOLUNTARY',
            product, originalTxId, appAccountToken, timestamp: trialEnd,
          }));
          count += 2;
          continue;
        }
      } else {
        continue;
      }
    } else {
      ingestApple(makeNotification({
        notificationType: 'SUBSCRIBED', subtype: 'INITIAL_BUY',
        product, originalTxId, appAccountToken, timestamp: at,
      }));
      count++;
      if (product.type !== 'Auto-Renewable Subscription') continue;
    }

    // Renewal zinciri
    let cursor = at + product.days * DAY;
    while (cursor < now) {
      const roll = Math.random();
      if (roll < 0.04) {
        // Gönüllü iptal: CANCELLATION + EXPIRATION
        ingestApple(makeNotification({
          notificationType: 'DID_CHANGE_RENEWAL_STATUS', subtype: 'AUTO_RENEW_DISABLED',
          product, originalTxId, appAccountToken, timestamp: cursor - 2 * DAY,
          overrides: { autoRenewStatus: 0 },
        }));
        ingestApple(makeNotification({
          notificationType: 'EXPIRED', subtype: 'VOLUNTARY',
          product, originalTxId, appAccountToken, timestamp: cursor,
        }));
        count += 2;
        break;
      } else if (roll < 0.05) {
        // Ödeme sorunu
        ingestApple(makeNotification({
          notificationType: 'DID_FAIL_TO_RENEW', subtype: 'GRACE_PERIOD',
          product, originalTxId, appAccountToken, timestamp: cursor,
        }));
        count++;
        break;
      } else if (roll < 0.055) {
        // Refund
        ingestApple(makeNotification({
          notificationType: 'REFUND', product, originalTxId, appAccountToken, timestamp: cursor,
          overrides: { transaction: { revocationReason: 0, revocationDate: cursor } },
        }));
        count++;
        cursor += product.days * DAY;
      } else {
        ingestApple(makeNotification({
          notificationType: 'DID_RENEW', product, originalTxId, appAccountToken, timestamp: cursor,
        }));
        count++;
        cursor += product.days * DAY;
      }
    }
  }
}

// Birkaç ekstra refund
for (let i = 0; i < 5; i++) {
  const at = now - Math.floor(Math.random() * 30 * DAY);
  const product = rand(PRODUCTS);
  ingestApple(makeNotification({
    notificationType: 'REFUND', product,
    originalTxId: 'otx_' + Math.random().toString(36).slice(2, 12),
    appAccountToken: uuid(),
    timestamp: at,
  }));
  count++;
}

console.log(`✓ ${count} App Store notifications processed.`);
process.exit(0);
