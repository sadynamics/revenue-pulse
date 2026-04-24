// Basit statik FX tablosu. Prod'da canlı bir rate API ile değiştirilebilir.
// Apple price/currency değerleri "milli-units" (1.000.000 = 1 birim) olarak gelir.

const FX_TO_USD = {
  USD: 1, EUR: 1.08, GBP: 1.27, TRY: 0.031, JPY: 0.0064,
  CAD: 0.73, AUD: 0.65, BRL: 0.20, MXN: 0.058, INR: 0.012,
  RUB: 0.011, CNY: 0.14, KRW: 0.00073, SEK: 0.095, NOK: 0.094,
  DKK: 0.14, CHF: 1.12, PLN: 0.25, ZAR: 0.053, SGD: 0.74,
  HKD: 0.13, NZD: 0.60, AED: 0.27, SAR: 0.27, THB: 0.027,
  IDR: 0.000063, PHP: 0.017, MYR: 0.22, VND: 0.000041,
  CZK: 0.043, HUF: 0.0027, RON: 0.22, UAH: 0.025, COP: 0.00025,
  CLP: 0.0011, ARS: 0.0011, EGP: 0.021, ILS: 0.27, NGN: 0.00076,
  PKR: 0.0036, TWD: 0.031,
};

export function toUsd(amount, currency) {
  if (amount == null) return 0;
  const rate = FX_TO_USD[(currency || 'USD').toUpperCase()] ?? 1;
  return Number((amount * rate).toFixed(4));
}

/** Apple price field'i milli-units cinsindendir (örn. 12990 = 12.99). */
export function fromAppleMilli(milli) {
  if (milli == null) return 0;
  return Number(milli) / 1000;
}
