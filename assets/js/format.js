// Small, dependency-free formatting helpers. All output is English on purpose:
// the UI copy is English, so mixing in the visitor's locale would look odd.

const countFormat = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const dateFormat = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const AVERAGE_MONTH_DAYS = 30.4375;
const AVERAGE_YEAR_DAYS = 365.25;

/** 1234 -> "1.2K". Anything that is not a finite, non-negative number is shown as 0. */
export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? countFormat.format(number) : '0';
}

/**
 * "just now", "5 minutes ago", "yesterday", "3 months ago", ...
 * Returns '' when `timestamp` is not a usable epoch-milliseconds value.
 * Timestamps in the future (clock skew) are treated as "just now".
 */
export function relativeTime(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '';
  const diff = now - timestamp;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return relativeFormat.format(-Math.floor(diff / MINUTE), 'minute');
  if (diff < DAY) return relativeFormat.format(-Math.floor(diff / HOUR), 'hour');
  const days = Math.floor(diff / DAY);
  if (days < 30) return relativeFormat.format(-days, 'day');
  // The Math.max(1, ...) guards keep the boundaries honest: 30 days is
  // "last month" (never "this month") and 365 days is "last year".
  if (days < 365) return relativeFormat.format(-Math.max(1, Math.floor(days / AVERAGE_MONTH_DAYS)), 'month');
  return relativeFormat.format(-Math.max(1, Math.floor(days / AVERAGE_YEAR_DAYS)), 'year');
}

/** "Nov 4, 2026" (UTC, so the same instant always renders the same date). */
export function formatDate(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0 ? dateFormat.format(timestamp) : '';
}

/** ISO-8601 string for <time datetime>, or '' for unusable input. */
export function isoDate(timestamp) {
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : '';
}

/** pluralize(1, 'project') -> "1 project", pluralize(2, 'project') -> "2 projects" */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** "in about 12 minutes" for a future instant; used for rate-limit hints. */
export function minutesUntil(timestamp, now = Date.now()) {
  if (!Number.isFinite(timestamp) || timestamp <= now) return 0;
  return Math.max(1, Math.ceil((timestamp - now) / MINUTE));
}
