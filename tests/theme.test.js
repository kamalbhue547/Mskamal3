import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { THEME_COLORS, THEME_KEY, initThemeToggle, nextTheme, resolveTheme } from '../assets/js/theme.js';
import { themeTokens } from './helpers/css.js';
import { createMatchMedia, createPage } from './helpers/dom.js';
import { brokenStorage, memoryStorage } from './helpers/fixtures.js';

const LIGHT = '(prefers-color-scheme: light)';

describe('resolveTheme / nextTheme', () => {
  test('an explicit, valid choice always wins', () => {
    assert.equal(resolveTheme({ stored: 'light', prefersLight: false }), 'light');
    assert.equal(resolveTheme({ stored: 'dark', prefersLight: true }), 'dark');
  });

  test('without a choice, the system preference decides and dark is the default', () => {
    assert.equal(resolveTheme({ stored: null, prefersLight: true }), 'light');
    assert.equal(resolveTheme({ stored: null, prefersLight: false }), 'dark');
    assert.equal(resolveTheme({}), 'dark');
  });

  test('garbage in storage is ignored', () => {
    for (const stored of ['', 'LIGHT', 'blue', '1', 'null', undefined]) {
      assert.equal(resolveTheme({ stored, prefersLight: true }), 'light', JSON.stringify(stored));
      assert.equal(resolveTheme({ stored, prefersLight: false }), 'dark', JSON.stringify(stored));
    }
  });

  test('nextTheme flips between the two themes', () => {
    assert.equal(nextTheme('dark'), 'light');
    assert.equal(nextTheme('light'), 'dark');
  });
});

describe('browser UI colour', () => {
  for (const theme of ['dark', 'light']) {
    test(`THEME_COLORS.${theme} equals --bg in the ${theme} theme of the stylesheet`, () => {
      assert.equal(THEME_COLORS[theme].toLowerCase(), themeTokens(theme)['--bg'].toLowerCase());
    });
  }
});

describe('initThemeToggle', () => {
  function setup({ storage = memoryStorage(), prefersLight = false } = {}) {
    const dom = createPage();
    const { document } = dom.window;
    const media = createMatchMedia({ [LIGHT]: prefersLight });
    const button = document.getElementById('theme-toggle');
    const toggle = initThemeToggle({ document, storage, matchMedia: media.matchMedia, button });
    return { document, media, button, storage, toggle, root: document.documentElement, meta: document.querySelector('meta[name="theme-color"]') };
  }

  test('starts from the system preference and labels the button for the action it performs', () => {
    const dark = setup({ prefersLight: false });
    assert.equal(dark.root.dataset.theme, 'dark');
    assert.equal(dark.button.getAttribute('aria-label'), 'Switch to light theme');
    assert.equal(dark.button.getAttribute('title'), 'Switch to light theme');
    assert.equal(dark.meta.getAttribute('content'), THEME_COLORS.dark);

    const light = setup({ prefersLight: true });
    assert.equal(light.root.dataset.theme, 'light');
    assert.equal(light.button.getAttribute('aria-label'), 'Switch to dark theme');
    assert.equal(light.meta.getAttribute('content'), THEME_COLORS.light);
  });

  test('a stored choice beats the system preference', () => {
    const page = setup({ storage: memoryStorage({ [THEME_KEY]: 'dark' }), prefersLight: true });
    assert.equal(page.root.dataset.theme, 'dark');
  });

  test('clicking toggles the theme, persists it, and keeps the label and browser colour in step', () => {
    const page = setup();
    page.button.click();
    assert.equal(page.root.dataset.theme, 'light');
    assert.equal(page.storage.getItem(THEME_KEY), 'light');
    assert.equal(page.button.getAttribute('aria-label'), 'Switch to dark theme');
    assert.equal(page.meta.getAttribute('content'), THEME_COLORS.light);
    assert.equal(page.toggle.theme, 'light');

    page.button.click();
    assert.equal(page.root.dataset.theme, 'dark');
    assert.equal(page.storage.getItem(THEME_KEY), 'dark');
    assert.equal(page.meta.getAttribute('content'), THEME_COLORS.dark);
  });

  test('follows the system theme live while the visitor has not chosen', () => {
    const page = setup();
    page.media.set(LIGHT, true);
    assert.equal(page.root.dataset.theme, 'light');
    page.media.set(LIGHT, false);
    assert.equal(page.root.dataset.theme, 'dark');
    assert.equal(page.storage.getItem(THEME_KEY), null, 'following the system must not store a choice');
  });

  test('stops following the system after an explicit choice', () => {
    const page = setup();
    page.button.click(); // dark -> light, explicit
    page.media.set(LIGHT, false);
    assert.equal(page.root.dataset.theme, 'light');
  });

  test('a stored choice also stops system changes from taking over', () => {
    const page = setup({ storage: memoryStorage({ [THEME_KEY]: 'dark' }) });
    page.media.set(LIGHT, true);
    assert.equal(page.root.dataset.theme, 'dark');
  });

  test('works when storage is blocked, and the in-session choice still beats system changes', () => {
    const page = setup({ storage: brokenStorage() });
    assert.equal(page.root.dataset.theme, 'dark');
    page.button.click();
    assert.equal(page.root.dataset.theme, 'light');
    page.media.set(LIGHT, false);
    assert.equal(page.root.dataset.theme, 'light', 'a choice made this session must survive an OS theme change');
  });

  test('works without storage at all, and without a theme-color meta tag', () => {
    const dom = createPage();
    const { document } = dom.window;
    document.querySelector('meta[name="theme-color"]').remove();
    const button = document.getElementById('theme-toggle');
    initThemeToggle({ document, storage: undefined, matchMedia: createMatchMedia().matchMedia, button });
    button.click();
    assert.equal(document.documentElement.dataset.theme, 'light');
  });
});

describe('theme-init.js (the classic script that prevents a flash of the wrong theme)', () => {
  const source = readFileSync(new URL('../assets/js/theme-init.js', import.meta.url), 'utf8');

  function run({ stored, prefersLight = false, blockedStorage = false, noMatchMedia = false }) {
    const { window } = createPage();
    if (stored !== undefined) window.localStorage.setItem(THEME_KEY, stored);
    if (!noMatchMedia) window.matchMedia = createMatchMedia({ [LIGHT]: prefersLight }).matchMedia;
    window.eval(blockedStorage ? `(function () { const localStorage = { getItem() { throw new Error('blocked'); } }; ${source} })();` : source);
    const root = window.document.documentElement;
    return { theme: root.dataset.theme, js: root.classList.contains('js') };
  }

  test('agrees with resolveTheme() for every combination of stored value and system preference', () => {
    for (const stored of [undefined, 'light', 'dark', 'bogus', '']) {
      for (const prefersLight of [false, true]) {
        const expected = resolveTheme({ stored: stored ?? null, prefersLight });
        assert.equal(run({ stored, prefersLight }).theme, expected, `stored=${JSON.stringify(stored)} prefersLight=${prefersLight}`);
      }
    }
  });

  test('marks the document as script-enabled', () => {
    assert.equal(run({}).js, true);
  });

  test('falls back to the system preference when storage throws', () => {
    assert.equal(run({ blockedStorage: true, prefersLight: true }).theme, 'light');
    assert.equal(run({ blockedStorage: true, prefersLight: false }).theme, 'dark');
  });

  test('falls back to dark when matchMedia is unavailable', () => {
    assert.equal(run({ noMatchMedia: true }).theme, 'dark');
    assert.equal(run({ noMatchMedia: true, stored: 'light' }).theme, 'light');
  });

  test('uses the same storage key as the theme module', () => {
    assert.ok(source.includes(`'${THEME_KEY}'`));
  });
});
