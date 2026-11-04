// Helpers for tests that inspect the stylesheet: design-token parsing and WCAG maths.

import { readFileSync } from 'node:fs';

export const CSS_PATH = new URL('../../assets/css/styles.css', import.meta.url);

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

export const readCss = () => stripComments(readFileSync(CSS_PATH, 'utf8'));

/** Custom properties declared in rules whose selector list contains `selector`. */
export function tokens(selector, css = readCss()) {
  const found = {};
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((part) => part.trim() === selector)) continue;
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) found[name] = value.trim();
  }
  return found;
}

/** Removes every block of the given at-rule (e.g. "@media"), including nested braces. */
function withoutAtRule(css, atRule) {
  let out = '';
  let index = 0;
  while (index < css.length) {
    if (!css.startsWith(atRule, index)) {
      out += css[index];
      index += 1;
      continue;
    }
    let depth = 0;
    let cursor = css.indexOf('{', index);
    if (cursor === -1) break;
    do {
      if (css[cursor] === '{') depth += 1;
      else if (css[cursor] === '}') depth -= 1;
      cursor += 1;
    } while (depth > 0 && cursor < css.length);
    index = cursor;
  }
  return out;
}

/**
 * The value the stylesheet declares for `property` on the rule with exactly this selector.
 * Only base rules count: declarations inside @media / @supports (such as the forced-colors
 * overrides) are ignored, and the last base declaration wins.
 */
export function declaration(selector, property, css = readCss()) {
  const base = withoutAtRule(withoutAtRule(css, '@media'), '@supports');
  let value;
  for (const [, selectors, body] of base.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some((part) => part.trim() === selector)) continue;
    for (const [, name, declared] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) if (name === property) value = declared.trim();
  }
  return value;
}

/** The alpha in a value like "rgb(var(--accent-rgb) / 0.16)". */
export function alphaOf(value) {
  const match = /\/\s*([\d.]+)\s*\)/.exec(value ?? '');
  if (!match) throw new Error(`No alpha found in ${JSON.stringify(value)}`);
  return Number(match[1]);
}

export const THEME_SELECTORS = { dark: ":root[data-theme='dark']", light: ":root[data-theme='light']" };

export const themeTokens = (theme, css) => tokens(THEME_SELECTORS[theme], css);

/** Parses "#rrggbb" into [r, g, b]. */
export function hex(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(value ?? '');
  if (!match) throw new Error(`Expected a #rrggbb colour but got ${JSON.stringify(value)}`);
  const n = Number.parseInt(match[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "139 123 255" or "139, 123, 255" into [139, 123, 255]. */
export function rgbTriple(value) {
  const parts = String(value).split(/[\s,]+/).filter(Boolean).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`Expected an "r g b" triple but got ${JSON.stringify(value)}`);
  return parts;
}

const channel = (value) => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance. */
export const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio between two [r, g, b] colours (1 to 21). */
export function contrast(a, b) {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

/** `fg` at `alpha` composited over `bg`: what you see for rgb(fg / alpha) on bg. */
export const blend = (fg, alpha, bg) => fg.map((value, index) => Math.round(value * alpha + bg[index] * (1 - alpha)));
