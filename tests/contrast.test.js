// Accessibility guard for the design tokens: every colour pairing the stylesheet
// actually uses must meet WCAG 2.2 AA in BOTH themes, including the translucent
// surfaces (tinted chips and pills) and gradients that automated checkers such
// as axe cannot evaluate. Where a pairing depends on a rule in the stylesheet,
// the test reads that rule, so changing the CSS without re-auditing it fails.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { alphaOf, blend, contrast, declaration, hex, readCss, rgbTriple, themeTokens, tokens } from './helpers/css.js';

const css = readCss();
const renderSource = readFileSync(new URL('../assets/js/render.js', import.meta.url), 'utf8');
const THEMES = ['dark', 'light'];

const AA_TEXT = 4.5;
const AA_LARGE_TEXT_OR_UI = 3; // large text, UI components and focus indicators (WCAG 1.4.3 / 1.4.11)

// Custom properties that JavaScript sets per element (colour dots, bar widths,
// the card stagger index), so the stylesheet legitimately never declares them.
const RUNTIME_PROPERTIES = ['--c', '--i', '--w'];

function assertContrast(label, foreground, background, minimum) {
  const ratio = contrast(foreground, background);
  assert.ok(ratio >= minimum, `${label}: contrast ${ratio.toFixed(2)}:1 is below the required ${minimum}:1`);
}

describe('design tokens', () => {
  test('both themes define exactly the same set of tokens', () => {
    assert.deepEqual(Object.keys(themeTokens('light', css)).sort(), Object.keys(themeTokens('dark', css)).sort());
  });

  test('every var(--token) used in the stylesheet is defined', () => {
    const defined = new Set([...Object.keys(themeTokens('dark', css)), ...Object.keys(tokens(':root', css)), ...RUNTIME_PROPERTIES]);
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]));
    const missing = [...used].filter((name) => !defined.has(name));
    assert.deepEqual(missing, [], `undefined custom properties: ${missing.join(', ')}`);
  });

  test('the runtime-only properties really are set by render.js', () => {
    for (const name of RUNTIME_PROPERTIES) assert.ok(renderSource.includes(`setProperty('${name}'`), `render.js never sets ${name}`);
  });

  for (const theme of THEMES) {
    test(`${theme}: the rgb triples match their hex colours (tints and canvas follow the accent)`, () => {
      const t = themeTokens(theme, css);
      assert.deepEqual(rgbTriple(t['--accent-rgb']), hex(t['--accent']));
      assert.deepEqual(rgbTriple(t['--accent-2-rgb']), hex(t['--accent-2']));
      assert.deepEqual(rgbTriple(t['--danger-rgb']), hex(t['--danger']));
      assert.deepEqual(rgbTriple(t['--backdrop-rgb']), hex(t['--accent']));
    });
  }

  test('hidden elements stay hidden even where a class sets display', () => {
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  test('respects reduced motion and forced colours', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(css, /@media \(forced-colors: active\)/);
  });
});

describe('the stylesheet really uses the audited pairings', () => {
  const rule = (selector, property) => declaration(selector, property, css);

  test('active filter chip: text on an accent tint, with a muted (not subtle) count', () => {
    assert.equal(rule(".chip[aria-pressed='true']", 'color'), 'var(--text)');
    assert.match(rule(".chip[aria-pressed='true']", 'background'), /^rgb\(var\(--accent-rgb\) \/ [\d.]+\)$/);
    assert.equal(rule(".chip[aria-pressed='true'] .chip-count", 'color'), 'var(--text-muted)');
  });

  test('idle filter chip: muted label with a subtle count', () => {
    assert.equal(rule('.chip', 'color'), 'var(--text-muted)');
    assert.equal(rule('.chip-count', 'color'), 'var(--text-subtle)');
  });

  test('topic pills: link colour on an accent tint', () => {
    assert.equal(rule('.topics li', 'color'), 'var(--link)');
    assert.match(rule('.topics li', 'background'), /^rgb\(var\(--accent-rgb\) \/ [\d.]+\)$/);
  });

  test('primary button: accent-contrast label on an accent to accent-2 gradient', () => {
    assert.equal(rule('.btn-primary', 'color'), 'var(--accent-contrast)');
    assert.match(rule('.btn-primary', 'background'), /linear-gradient\(135deg, var\(--accent\), var\(--accent-2\)\)/);
  });

  test('hero title: a gradient through --text, --accent and --accent-2', () => {
    assert.match(rule('.hero-title', 'background'), /var\(--text\).*var\(--accent\).*var\(--accent-2\)/s);
  });

  test('form controls use the stronger control border', () => {
    assert.equal(rule(".field input[type='search']", 'border'), '1px solid var(--control-border)');
    assert.equal(rule('.field select', 'border'), '1px solid var(--control-border)');
    assert.equal(rule('.icon-button', 'border'), '1px solid var(--control-border)');
  });

  test('error titles use the danger colour', () => {
    assert.equal(rule(".message-state[role='alert'] .message-title", 'color'), 'var(--danger)');
  });
});

for (const theme of THEMES) {
  describe(`WCAG AA contrast: ${theme} theme`, () => {
    const t = themeTokens(theme, css);
    const colour = (name) => hex(t[name]);
    const bg = colour('--bg');
    const elev = colour('--bg-elev');
    const elev2 = colour('--bg-elev-2');
    const surfaces = { 'page background': bg, 'card surface': elev, 'raised surface': elev2 };
    const accentTint = (alpha, base) => blend(rgbTriple(t['--accent-rgb']), alpha, base);
    const alpha = (selector, property) => alphaOf(declaration(selector, property, css));

    for (const textToken of ['--text', '--text-muted', '--text-subtle']) {
      for (const [surfaceName, surface] of Object.entries(surfaces)) {
        test(`${textToken} on the ${surfaceName}`, () => assertContrast(`${textToken} on ${surfaceName}`, colour(textToken), surface, AA_TEXT));
      }
    }

    test('links on the page and card surfaces', () => {
      assertContrast('--link on --bg', colour('--link'), bg, AA_TEXT);
      assertContrast('--link on --bg-elev', colour('--link'), elev, AA_TEXT);
    });

    test('topic pills: link colour on the accent-tinted card surface', () => {
      assertContrast('topic pill', colour('--link'), accentTint(alpha('.topics li', 'background'), elev), AA_TEXT);
    });

    test('error titles on the message surface', () => {
      assertContrast('--danger on --bg-elev', colour('--danger'), elev, AA_TEXT);
    });

    test('primary button: label colour on every point of the gradient', () => {
      const [from, to] = [colour('--accent'), colour('--accent-2')];
      for (const step of [0, 0.25, 0.5, 0.75, 1]) {
        assertContrast(`--accent-contrast at ${step * 100}% of the gradient`, colour('--accent-contrast'), blend(to, step, from), AA_TEXT);
      }
    });

    test('active filter chip: label and count on the accent-tinted page surface', () => {
      const active = accentTint(alpha(".chip[aria-pressed='true']", 'background'), bg);
      assertContrast('chip label (--text)', colour('--text'), active, AA_TEXT);
      assertContrast('chip count (--text-muted)', colour('--text-muted'), active, AA_TEXT);
    });

    test('idle filter chip: label and count on the page surface', () => {
      assertContrast('chip label (--text-muted)', colour('--text-muted'), bg, AA_TEXT);
      assertContrast('chip count (--text-subtle)', colour('--text-subtle'), bg, AA_TEXT);
    });

    test('hero title (large text): every gradient stop on the page surface', () => {
      for (const token of ['--text', '--accent', '--accent-2']) assertContrast(`hero title ${token}`, colour(token), bg, AA_LARGE_TEXT_OR_UI);
    });

    test('focus ring is visible on every surface it can be drawn on (3:1)', () => {
      for (const [name, surface] of Object.entries(surfaces)) assertContrast(`--focus on ${name}`, colour('--focus'), surface, AA_LARGE_TEXT_OR_UI);
    });

    test('accent used for selected-state borders is visible (3:1)', () => {
      assertContrast('--accent on --bg', colour('--accent'), bg, AA_LARGE_TEXT_OR_UI);
      assertContrast('--accent on --bg-elev', colour('--accent'), elev, AA_LARGE_TEXT_OR_UI);
    });

    test('form control borders are visible (3:1)', () => {
      assertContrast('--control-border on --bg-elev', colour('--control-border'), elev, AA_LARGE_TEXT_OR_UI);
      assertContrast('--control-border on --bg', colour('--control-border'), bg, AA_LARGE_TEXT_OR_UI);
    });
  });
}
