// Static FX table covering all currencies Apple App Store Connect supports
// for in-app purchase pricing. Rates are approximate (Q2 2026 snapshot) and
// good enough for revenue dashboards; for accounting use App Store Connect
// financial reports instead — see Apple's note on the JWS price field.
//
// Apple's `price` field is in **milliunits**: `1 unit of currency = 1000 milliunits`.
// e.g. $1.99 → 1990, ₩3,300 → 3,300,000, ¥300 → 300,000.

const FX_TO_USD = {
  // Major reserve & European currencies
  USD: 1,
  EUR: 1.08, GBP: 1.27, CHF: 1.12, NOK: 0.094, SEK: 0.095, DKK: 0.14,
  ISK: 0.0073, PLN: 0.25, CZK: 0.043, HUF: 0.0027, RON: 0.22, BGN: 0.55,
  HRK: 0.14, RSD: 0.0092, ALL: 0.011, BAM: 0.55, MKD: 0.018, MDL: 0.058,

  // Americas
  CAD: 0.73, MXN: 0.058, BRL: 0.20, ARS: 0.0011, CLP: 0.0011,
  COP: 0.00025, PEN: 0.27, UYU: 0.025, BOB: 0.14, PYG: 0.00013,
  CRC: 0.0019, GTQ: 0.13, HNL: 0.040, NIO: 0.027, DOP: 0.017,
  JMD: 0.0064, TTD: 0.15, BBD: 0.50, BSD: 1.0, BMD: 1.0, BZD: 0.50,

  // Asia-Pacific
  JPY: 0.0064, CNY: 0.14, HKD: 0.13, TWD: 0.031, KRW: 0.00073,
  SGD: 0.74, MYR: 0.22, IDR: 0.000063, PHP: 0.017, VND: 0.000041,
  THB: 0.027, INR: 0.012, PKR: 0.0036, BDT: 0.0091, LKR: 0.0033,
  NPR: 0.0075, AFN: 0.014, MMK: 0.00048, KHR: 0.00024, LAK: 0.000046,
  MNT: 0.00029,
  AUD: 0.65, NZD: 0.60, FJD: 0.45, PGK: 0.27,

  // Middle East
  TRY: 0.031, AED: 0.27, SAR: 0.27, QAR: 0.27, KWD: 3.27, BHD: 2.65,
  OMR: 2.60, JOD: 1.41, ILS: 0.27, LBP: 0.000011, IQD: 0.00076,
  IRR: 0.000024, YER: 0.0040,

  // Caucasus & Central Asia
  KZT: 0.0021, AZN: 0.59, GEL: 0.37, AMD: 0.0026, BYN: 0.31,
  UZS: 0.000079, KGS: 0.011, TJS: 0.092, TMT: 0.29,

  // Africa
  ZAR: 0.053, EGP: 0.021, NGN: 0.00076, KES: 0.0078, GHS: 0.067,
  TZS: 0.00039, UGX: 0.00027, ETB: 0.0079, MAD: 0.10, TND: 0.32,
  DZD: 0.0074, MUR: 0.022, MZN: 0.016, AOA: 0.0011, RWF: 0.00076,
  XOF: 0.00164, XAF: 0.00164,

  // Russia / former CIS
  RUB: 0.011, UAH: 0.025,
};

/**
 * Convert a major-unit currency amount to USD.
 * Returns `null` when the currency rate is unknown — callers MUST fall back
 * to local-currency display (and analytics SUM treats null as zero).
 *
 * Defaulting unknown rates to 1 used to silently render KZT 2990 as "$2,990".
 */
export function toUsd(amount, currency) {
  if (amount == null) return 0;
  const code = (currency || 'USD').toUpperCase();
  const rate = FX_TO_USD[code];
  if (rate == null) {
    if (!_warnedCurrencies.has(code)) {
      _warnedCurrencies.add(code);
      console.warn(`[fx] No FX rate for "${code}" — USD value left blank for this currency until you add it to FX_TO_USD.`);
    }
    return null;
  }
  return Number((amount * rate).toFixed(4));
}

const _warnedCurrencies = new Set();

/** Apple price field'i milli-units cinsindendir (örn. 12990 = 12.99 USD, 3300000 = 3300 KRW). */
export function fromAppleMilli(milli) {
  if (milli == null) return 0;
  return Number(milli) / 1000;
}

export function isCurrencySupported(code) {
  return Object.prototype.hasOwnProperty.call(FX_TO_USD, (code || '').toUpperCase());
}
