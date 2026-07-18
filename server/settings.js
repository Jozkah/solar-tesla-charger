// DB-coupled settings layer: persists billing day + tariff in the SQLite KV
// store. Pure validation/defaults live in cost.js; config.json only seeds the
// billing-day default. Never writes to config.json (keeps secrets untouched).
import { getSetting, setSetting } from './db.js';
import config from './config.js';
import { DEFAULT_TARIFF, validateTariff } from './cost.js';

export function validateBillingDay(day) {
  const n = Number(day);
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    const e = new Error('billingDay must be an integer 1–31');
    e.code = 'INVALID_SETTING';
    throw e;
  }
  return n;
}

export function getBillingDay() {
  const raw = getSetting('billingDay');
  if (raw != null) {
    const n = parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 31) return n;
  }
  const def = config.stats?.billingDay;
  return Number.isInteger(def) && def >= 1 && def <= 31 ? def : 1;
}

export function setBillingDay(day) {
  const n = validateBillingDay(day);
  setSetting('billingDay', String(n));
  return n;
}

export function getTariff() {
  const raw = getSetting('tariff');
  if (raw != null) {
    try {
      return validateTariff(JSON.parse(raw));
    } catch {
      /* corrupt/invalid stored tariff -> fall back to default */
    }
  }
  return DEFAULT_TARIFF;
}

export function setTariff(t) {
  validateTariff(t);
  setSetting('tariff', JSON.stringify(t));
  return t;
}

// Validate everything present, THEN persist, so a partial/invalid POST writes
// nothing.
export function applySettings({ billingDay, tariff } = {}) {
  if (billingDay !== undefined) validateBillingDay(billingDay);
  if (tariff !== undefined) validateTariff(tariff);
  if (billingDay !== undefined) setBillingDay(billingDay);
  if (tariff !== undefined) setTariff(tariff);
  return { billingDay: getBillingDay(), tariff: getTariff() };
}
