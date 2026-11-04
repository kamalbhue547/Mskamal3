import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCount, formatDate, isoDate, minutesUntil, pluralize, relativeTime } from '../assets/js/format.js';
import { NOW } from './helpers/fixtures.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('formatCount compacts large numbers and never shows junk', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(7), '7');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1000), '1K');
  assert.equal(formatCount(1234), '1.2K');
  assert.equal(formatCount(1_250_000), '1.3M');
  for (const junk of ['x', undefined, null, NaN, -5, Infinity]) {
    assert.equal(formatCount(junk), '0', `formatCount(${String(junk)})`);
  }
});

test('relativeTime picks a sensible unit at every boundary', () => {
  const at = (ms) => relativeTime(NOW - ms, NOW);
  assert.equal(at(30_000), 'just now');
  assert.equal(at(MINUTE), '1 minute ago');
  assert.equal(at(5 * MINUTE), '5 minutes ago');
  assert.equal(at(59 * MINUTE), '59 minutes ago');
  assert.equal(at(HOUR), '1 hour ago');
  assert.equal(at(23 * HOUR), '23 hours ago');
  assert.equal(at(26 * HOUR), 'yesterday');
  assert.equal(at(3 * DAY), '3 days ago');
  assert.equal(at(29 * DAY), '29 days ago');
  assert.equal(at(100 * DAY), '3 months ago');
});

test('relativeTime never says "this month"/"this year" and never "12 months"', () => {
  const at = (days) => relativeTime(NOW - days * DAY, NOW);
  assert.equal(at(30), 'last month');
  assert.equal(at(45), 'last month');
  assert.equal(at(364), '11 months ago');
  assert.equal(at(365), 'last year');
  assert.equal(at(400), 'last year');
  assert.equal(at(800), '2 years ago');
});

test('relativeTime treats future and unusable timestamps safely', () => {
  assert.equal(relativeTime(NOW + 5 * MINUTE, NOW), 'just now');
  for (const bad of [0, -1, NaN, undefined, null, '2026-01-01']) {
    assert.equal(relativeTime(bad, NOW), '', `relativeTime(${String(bad)})`);
  }
});

test('formatDate and isoDate are UTC-stable and reject junk', () => {
  const lateOnFirst = Date.UTC(2026, 10, 1, 23, 59);
  assert.equal(formatDate(lateOnFirst), 'Nov 1, 2026');
  assert.equal(isoDate(Date.UTC(2026, 10, 1, 3, 4, 5)), '2026-11-01T03:04:05.000Z');
  for (const bad of [0, NaN, undefined]) {
    assert.equal(formatDate(bad), '');
    assert.equal(isoDate(bad), '');
  }
});

test('pluralize', () => {
  assert.equal(pluralize(1, 'project'), '1 project');
  assert.equal(pluralize(0, 'project'), '0 projects');
  assert.equal(pluralize(2, 'repository', 'repositories'), '2 repositories');
});

test('minutesUntil rounds up and bottoms out at 0', () => {
  assert.equal(minutesUntil(NOW + 30_000, NOW), 1);
  assert.equal(minutesUntil(NOW + 61_000, NOW), 2);
  assert.equal(minutesUntil(NOW - 1, NOW), 0);
  assert.equal(minutesUntil(NaN, NOW), 0);
});
