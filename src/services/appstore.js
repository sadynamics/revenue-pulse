import crypto from 'node:crypto';
import { fromAppleMilli, toUsd } from './fx.js';

/**
 * Apple App Store Server Notifications V2 adapter.
 *
 * Docs:
 *  - https://developer.apple.com/documentation/appstoreservernotifications
 *  - https://developer.apple.com/documentation/appstoreservernotifications/responsebodyv2decodedpayload
 *  - https://developer.apple.com/documentation/appstoreservernotifications/notificationtype
 *
 * Payload: { "signedPayload": "<JWS>" }
 *
 * The JWS has 3 base64url parts (header.payload.signature). The payload contains:
 *   notificationType, subtype, notificationUUID, data: {
 *     appAppleId, bundleId, environment,
 *     signedTransactionInfo  (JWS -> JWSTransactionDecodedPayload),
 *     signedRenewalInfo      (JWS -> JWSRenewalInfoDecodedPayload)
 *   }, version, signedDate
 *
 * Bu modülün görevleri:
 *   1. JWS'i (opsiyonel olarak imza doğrulayarak) decode et
 *   2. İç içe signedTransactionInfo / signedRenewalInfo alanlarını da decode et
 *   3. Apple event tipini (notificationType + subtype) bizim generic event modelimize map et
 */

// ---------------------------------------------------------------
// JWS decode
// ---------------------------------------------------------------

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Buffer.from(b64, 'base64');
}

function decodeJwsHeader(jws) {
  const [h] = jws.split('.');
  return JSON.parse(b64urlDecode(h).toString('utf8'));
}

export function decodeJwsPayload(jws) {
  const [, p] = jws.split('.');
  return JSON.parse(b64urlDecode(p).toString('utf8'));
}

/**
 * ES256 ile JWS doğrulaması. Apple sertifikalarının x5c zinciri header'da gelir.
 * Tam doğrulama için x5c zincirinin Apple Root CA'ya ulaşması da kontrol edilmelidir.
 *
 * Prod için önerilen: @apple/app-store-server-library paketini kullanmak.
 * Burada hem hafif hem de pratik bir verification sunuyoruz:
 *   - İmzayı x5c[0] public key ile doğrular
 *   - (opsiyonel) x5c zincirinin root sertifikaya match ettiğini kontrol eder
 */
export function verifyJws(jws, { appleRootCertPem } = {}) {
  const header = decodeJwsHeader(jws);
  if (!header.alg || header.alg !== 'ES256') {
    throw new Error(`Unsupported JWS alg: ${header.alg}`);
  }
  const x5c = header.x5c || [];
  if (!x5c.length) throw new Error('Missing x5c chain in JWS header');

  const leafCertPem = `-----BEGIN CERTIFICATE-----\n${x5c[0]}\n-----END CERTIFICATE-----`;
  const pubKey = crypto.createPublicKey(leafCertPem);

  const [h, p, s] = jws.split('.');
  const signingInput = Buffer.from(`${h}.${p}`);
  const rawSig = b64urlDecode(s);
  // JWS uses "raw" ECDSA r||s (64 bytes for P-256). Convert to DER for crypto.verify.
  const derSig = ecdsaRawToDer(rawSig);

  const ok = crypto.verify('SHA256', signingInput, pubKey, derSig);
  if (!ok) throw new Error('JWS signature verification failed');

  // Opsiyonel: zinciri Apple Root CA'ya kadar doğrula
  if (appleRootCertPem) {
    const rootCert = new crypto.X509Certificate(appleRootCertPem);
    let lastCert = new crypto.X509Certificate(leafCertPem);
    for (let i = 1; i < x5c.length; i++) {
      const next = new crypto.X509Certificate(`-----BEGIN CERTIFICATE-----\n${x5c[i]}\n-----END CERTIFICATE-----`);
      if (!lastCert.verify(next.publicKey)) throw new Error(`x5c chain broken at index ${i}`);
      lastCert = next;
    }
    if (!lastCert.verify(rootCert.publicKey)) throw new Error('x5c chain does not terminate at Apple root');
  }

  return decodeJwsPayload(jws);
}

/** ECDSA imzasını raw (r||s) → DER formatına çevirir. */
function ecdsaRawToDer(raw) {
  const half = raw.length / 2;
  const r = trimZero(raw.slice(0, half));
  const s = trimZero(raw.slice(half));
  const seq = Buffer.concat([encodeInt(r), encodeInt(s)]);
  return Buffer.concat([Buffer.from([0x30, seq.length]), seq]);
}
function trimZero(buf) { let i = 0; while (i < buf.length - 1 && buf[i] === 0) i++; return buf.slice(i); }
function encodeInt(buf) {
  const needPad = buf[0] & 0x80;
  const body = needPad ? Buffer.concat([Buffer.from([0x00]), buf]) : buf;
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

// ---------------------------------------------------------------
// Notification decode
// ---------------------------------------------------------------

export function decodeNotification(signedPayload, { verify = true, appleRootCertPem } = {}) {
  const decodeFn = (jws) => (verify ? verifyJws(jws, { appleRootCertPem }) : decodeJwsPayload(jws));
  const top = decodeFn(signedPayload);

  const data = top.data || {};
  const transactionInfo = data.signedTransactionInfo ? decodeFn(data.signedTransactionInfo) : null;
  const renewalInfo     = data.signedRenewalInfo     ? decodeFn(data.signedRenewalInfo)     : null;

  return {
    notificationType: top.notificationType,
    subtype: top.subtype || null,
    notificationUUID: top.notificationUUID,
    version: top.version,
    signedDate: top.signedDate,
    summary: top.summary || null,
    data: {
      appAppleId: data.appAppleId,
      bundleId: data.bundleId,
      bundleVersion: data.bundleVersion,
      environment: data.environment,
      status: data.status,
    },
    transactionInfo,
    renewalInfo,
  };
}

// ---------------------------------------------------------------
// Apple → internal event mapping
// ---------------------------------------------------------------

/**
 * Apple notificationType + subtype kombinasyonlarını bizim event tiplerimize map eder.
 * Bazı bildirimler birden fazla event üretebilir (örn. SUBSCRIBED+BILLING_RECOVERY = BILLING_ISSUE_RESOLVED + RENEWAL).
 */
function mapTypeAndSubtype(notificationType, subtype) {
  const key = `${notificationType}:${subtype || ''}`;
  const direct = {
    // Yeni abonelikler
    'SUBSCRIBED:INITIAL_BUY':       'INITIAL_PURCHASE',
    'SUBSCRIBED:RESUBSCRIBE':       'UNCANCELLATION',

    // Yenilemeler
    'DID_RENEW:':                   'RENEWAL',
    'DID_RENEW:BILLING_RECOVERY':   'RENEWAL',

    // Abonelik değişiklikleri
    'DID_CHANGE_RENEWAL_PREF:UPGRADE':   'PRODUCT_CHANGE',
    'DID_CHANGE_RENEWAL_PREF:DOWNGRADE': 'PRODUCT_CHANGE',
    'DID_CHANGE_RENEWAL_PREF:':          'PRODUCT_CHANGE',

    // Auto-renew aç/kapat
    'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_DISABLED': 'CANCELLATION',
    'DID_CHANGE_RENEWAL_STATUS:AUTO_RENEW_ENABLED':  'UNCANCELLATION',

    // Sona erme / ödeme sorunları
    'EXPIRED:VOLUNTARY':               'EXPIRATION',
    'EXPIRED:BILLING_RETRY':           'EXPIRATION',
    'EXPIRED:PRICE_INCREASE':          'EXPIRATION',
    'EXPIRED:PRODUCT_NOT_FOR_SALE':    'EXPIRATION',
    'EXPIRED:':                        'EXPIRATION',
    'DID_FAIL_TO_RENEW:':              'BILLING_ISSUE',
    'DID_FAIL_TO_RENEW:GRACE_PERIOD':  'BILLING_ISSUE',
    'GRACE_PERIOD_EXPIRED:':           'EXPIRATION',

    // Geri ödemeler
    'REFUND:':                         'REFUND',
    'REFUND_DECLINED:':                'REFUND_DECLINED',
    'REFUND_REVERSED:':                'REFUND_REVERSED',

    // Family share / iptal edilen erişim
    'REVOKE:':                         'EXPIRATION',

    // Uzatmalar
    'RENEWAL_EXTENDED:':               'SUBSCRIPTION_EXTENDED',
    'RENEWAL_EXTENSION:SUMMARY':       'SUBSCRIPTION_EXTENDED',
    'RENEWAL_EXTENSION:FAILURE':       'SUBSCRIPTION_EXTENDED',

    // Teklif / Fiyat
    'OFFER_REDEEMED:INITIAL_BUY':      'INITIAL_PURCHASE',
    'OFFER_REDEEMED:RESUBSCRIBE':      'UNCANCELLATION',
    'OFFER_REDEEMED:UPGRADE':          'PRODUCT_CHANGE',
    'OFFER_REDEEMED:DOWNGRADE':        'PRODUCT_CHANGE',
    'OFFER_REDEEMED:':                 'PRODUCT_CHANGE',
    'PRICE_INCREASE:PENDING':          'PRICE_INCREASE_CONSENT',
    'PRICE_INCREASE:ACCEPTED':         'PRICE_INCREASE_CONSENT',

    // Tek seferlik
    'ONE_TIME_CHARGE:':                'NON_RENEWING_PURCHASE',

    // Test
    'TEST:':                           'TEST',
  };

  if (direct[key]) return direct[key];
  if (direct[`${notificationType}:`]) return direct[`${notificationType}:`];
  return notificationType; // fallback: tipi aynen geçir
}

/**
 * Apple transaction.type + offerType'dan period_type belirler.
 * transaction.type: "Auto-Renewable Subscription" | "Non-Renewing Subscription" | "Non-Consumable" | "Consumable"
 * offerType: 1 (Introductory), 2 (Promotional), 3 (Subscription Offer Code)
 * offerDiscountType: "FREE_TRIAL" | "PAY_AS_YOU_GO" | "PAY_UP_FRONT"
 */
function derivePeriodType(tx) {
  if (!tx) return null;
  if (tx.offerDiscountType === 'FREE_TRIAL') return 'TRIAL';
  if (tx.type === 'Non-Renewing Subscription') return 'NON_RENEWING';
  if (tx.type === 'Non-Consumable') return 'LIFETIME';
  if (tx.type === 'Consumable') return 'CONSUMABLE';
  // "Auto-Renewable Subscription" ise period_type'ı Apple notification'dan direkt öğrenemeyiz;
  // product config'inden veya expiresDate - purchaseDate farkından tahmin ederiz.
  if (tx.purchaseDate && tx.expiresDate) {
    const days = Math.round((tx.expiresDate - tx.purchaseDate) / 86400000);
    if (days <= 10)   return 'WEEKLY';
    if (days <= 40)   return 'MONTHLY';
    if (days <= 100)  return 'QUARTERLY';
    if (days <= 200)  return 'SEMI_ANNUAL';
    return 'ANNUAL';
  }
  return 'NORMAL';
}

/**
 * Complete ISO 3166-1 alpha-3 → alpha-2 mapping for every Apple App Store
 * storefront. Naively slicing the first 2 characters of the alpha-3 produces
 * wrong codes for many real countries (e.g. KAZ → "KA" instead of "KZ",
 * AZE → "AZ" was correct only by accident, DEU → "DE" coincidence, etc.) —
 * always look up the canonical mapping.
 */
const STOREFRONT_A3_TO_A2 = {
  AFG:'AF', ALA:'AX', ALB:'AL', DZA:'DZ', ASM:'AS', AND:'AD', AGO:'AO',
  AIA:'AI', ATA:'AQ', ATG:'AG', ARG:'AR', ARM:'AM', ABW:'AW', AUS:'AU',
  AUT:'AT', AZE:'AZ', BHS:'BS', BHR:'BH', BGD:'BD', BRB:'BB', BLR:'BY',
  BEL:'BE', BLZ:'BZ', BEN:'BJ', BMU:'BM', BTN:'BT', BOL:'BO', BES:'BQ',
  BIH:'BA', BWA:'BW', BVT:'BV', BRA:'BR', IOT:'IO', BRN:'BN', BGR:'BG',
  BFA:'BF', BDI:'BI', CPV:'CV', KHM:'KH', CMR:'CM', CAN:'CA', CYM:'KY',
  CAF:'CF', TCD:'TD', CHL:'CL', CHN:'CN', CXR:'CX', CCK:'CC', COL:'CO',
  COM:'KM', COG:'CG', COD:'CD', COK:'CK', CRI:'CR', CIV:'CI', HRV:'HR',
  CUB:'CU', CUW:'CW', CYP:'CY', CZE:'CZ', DNK:'DK', DJI:'DJ', DMA:'DM',
  DOM:'DO', ECU:'EC', EGY:'EG', SLV:'SV', GNQ:'GQ', ERI:'ER', EST:'EE',
  SWZ:'SZ', ETH:'ET', FLK:'FK', FRO:'FO', FJI:'FJ', FIN:'FI', FRA:'FR',
  GUF:'GF', PYF:'PF', ATF:'TF', GAB:'GA', GMB:'GM', GEO:'GE', DEU:'DE',
  GHA:'GH', GIB:'GI', GRC:'GR', GRL:'GL', GRD:'GD', GLP:'GP', GUM:'GU',
  GTM:'GT', GGY:'GG', GIN:'GN', GNB:'GW', GUY:'GY', HTI:'HT', HMD:'HM',
  VAT:'VA', HND:'HN', HKG:'HK', HUN:'HU', ISL:'IS', IND:'IN', IDN:'ID',
  IRN:'IR', IRQ:'IQ', IRL:'IE', IMN:'IM', ISR:'IL', ITA:'IT', JAM:'JM',
  JPN:'JP', JEY:'JE', JOR:'JO', KAZ:'KZ', KEN:'KE', KIR:'KI', PRK:'KP',
  KOR:'KR', KWT:'KW', KGZ:'KG', LAO:'LA', LVA:'LV', LBN:'LB', LSO:'LS',
  LBR:'LR', LBY:'LY', LIE:'LI', LTU:'LT', LUX:'LU', MAC:'MO', MDG:'MG',
  MWI:'MW', MYS:'MY', MDV:'MV', MLI:'ML', MLT:'MT', MHL:'MH', MTQ:'MQ',
  MRT:'MR', MUS:'MU', MYT:'YT', MEX:'MX', FSM:'FM', MDA:'MD', MCO:'MC',
  MNG:'MN', MNE:'ME', MSR:'MS', MAR:'MA', MOZ:'MZ', MMR:'MM', NAM:'NA',
  NRU:'NR', NPL:'NP', NLD:'NL', NCL:'NC', NZL:'NZ', NIC:'NI', NER:'NE',
  NGA:'NG', NIU:'NU', NFK:'NF', MKD:'MK', MNP:'MP', NOR:'NO', OMN:'OM',
  PAK:'PK', PLW:'PW', PSE:'PS', PAN:'PA', PNG:'PG', PRY:'PY', PER:'PE',
  PHL:'PH', PCN:'PN', POL:'PL', PRT:'PT', PRI:'PR', QAT:'QA', REU:'RE',
  ROU:'RO', RUS:'RU', RWA:'RW', BLM:'BL', SHN:'SH', KNA:'KN', LCA:'LC',
  MAF:'MF', SPM:'PM', VCT:'VC', WSM:'WS', SMR:'SM', STP:'ST', SAU:'SA',
  SEN:'SN', SRB:'RS', SYC:'SC', SLE:'SL', SGP:'SG', SXM:'SX', SVK:'SK',
  SVN:'SI', SLB:'SB', SOM:'SO', ZAF:'ZA', SGS:'GS', SSD:'SS', ESP:'ES',
  LKA:'LK', SDN:'SD', SUR:'SR', SJM:'SJ', SWE:'SE', CHE:'CH', SYR:'SY',
  TWN:'TW', TJK:'TJ', TZA:'TZ', THA:'TH', TLS:'TL', TGO:'TG', TKL:'TK',
  TON:'TO', TTO:'TT', TUN:'TN', TUR:'TR', TKM:'TM', TCA:'TC', TUV:'TV',
  UGA:'UG', UKR:'UA', ARE:'AE', GBR:'GB', USA:'US', UMI:'UM', URY:'UY',
  UZB:'UZ', VUT:'VU', VEN:'VE', VNM:'VN', VGB:'VG', VIR:'VI', WLF:'WF',
  ESH:'EH', YEM:'YE', ZMB:'ZM', ZWE:'ZW',
};

function storefrontToA2(storefront) {
  if (!storefront) return null;
  const upper = storefront.toUpperCase();
  // Already alpha-2? (Apple usually sends alpha-3, but be defensive.)
  if (upper.length === 2 && /^[A-Z]{2}$/.test(upper)) return upper;
  return STOREFRONT_A3_TO_A2[upper] || null;
}

/**
 * Apple refund'ları: REFUND event'i geldiğinde transaction tam price'ı geri ödenmiş demektir
 * (Apple consumption API'ı kısmi refund desteklemez — notification seviyesinde hepsi full).
 */

/** notification (decoded) → bizim event modelimize map eder. Array döner. */
export function mapNotification(decoded, { appId = null } = {}) {
  const {
    notificationType, subtype, notificationUUID, signedDate,
    transactionInfo: tx, renewalInfo: ri, data,
  } = decoded;

  const type = mapTypeAndSubtype(notificationType, subtype);
  const now = signedDate || Date.now();

  // User identity: appAccountToken varsa (müşterinin kendi user ID'si) onu kullan,
  // yoksa originalTransactionId'yi stable identifier olarak al.
  const appUserId = tx?.appAccountToken || tx?.originalTransactionId || null;

  // Price/currency: Apple milli-units verir.
  const currency = tx?.currency || 'USD';
  const priceMajor = fromAppleMilli(tx?.price);
  const priceUsd = toUsd(priceMajor, currency);

  // REFUND için price negatif değil, ama LTV'den çıkarılsın diye |price| döneriz
  // (events.js zaten Math.abs kullanıyor).

  // Trial conversion bilgisi events.js içinde otomatik tespit edilir
  // (önceki dönem TRIAL ise gelen RENEWAL conversion sayılır). Burada set etmiyoruz.

  // will_renew bilgisi renewalInfo.autoRenewStatus'tan gelir (0|1)
  // (bunu doğrudan event'te kullanmıyoruz; CANCELLATION/UNCANCELLATION map'leri zaten yakalıyor)

  const base = {
    event_id: notificationUUID,
    app_id: appId,
    type,
    subtype: subtype || null,
    app_user_id: appUserId,
    original_app_user_id: tx?.originalTransactionId || appUserId,
    aliases: tx?.appAccountToken && tx?.originalTransactionId && tx.appAccountToken !== tx.originalTransactionId
      ? [tx.originalTransactionId]
      : [],
    product_id: tx?.productId || ri?.productId || null,
    entitlement_ids: tx?.subscriptionGroupIdentifier ? [tx.subscriptionGroupIdentifier] : [],
    period_type: derivePeriodType(tx),
    purchased_at_ms: tx?.purchaseDate || null,
    expiration_at_ms: tx?.expiresDate || ri?.renewalDate || null,
    event_timestamp_ms: now,
    environment: (data?.environment || tx?.environment || 'Production').toUpperCase() === 'SANDBOX' ? 'SANDBOX' : 'PRODUCTION',
    store: 'APP_STORE',
    currency,
    price: priceMajor,
    price_usd: priceUsd,
    country_code: storefrontToA2(tx?.storefront),
    is_family_share: tx?.inAppOwnershipType === 'FAMILY_SHARED' ? 1 : 0,
    is_trial_conversion: 0,
    cancel_reason: cancelReason(notificationType, subtype, ri),
    expiration_reason: expirationReason(notificationType, subtype, ri),
    transaction_id: tx?.transactionId || null,
    original_transaction_id: tx?.originalTransactionId || null,
    web_order_line_item_id: tx?.webOrderLineItemId || null,
    offer_code: tx?.offerIdentifier || ri?.offerIdentifier || null,
    raw_json: JSON.stringify(decoded),
  };

  return [base];
}

function cancelReason(nt, st, ri) {
  if (nt === 'DID_CHANGE_RENEWAL_STATUS' && st === 'AUTO_RENEW_DISABLED') return 'user_disabled_auto_renew';
  if (nt === 'REFUND') return 'refund';
  if (nt === 'REVOKE') return 'family_sharing_revoked';
  return null;
}

function expirationReason(nt, st, ri) {
  if (nt === 'EXPIRED') {
    const m = { VOLUNTARY:'voluntary', BILLING_RETRY:'billing_retry', PRICE_INCREASE:'price_increase_not_accepted', PRODUCT_NOT_FOR_SALE:'product_not_for_sale' };
    return m[st] || 'expired';
  }
  if (nt === 'DID_FAIL_TO_RENEW') return 'billing_issue';
  if (nt === 'GRACE_PERIOD_EXPIRED') return 'grace_period_ended';
  if (nt === 'REVOKE') return 'revoked';
  return null;
}
