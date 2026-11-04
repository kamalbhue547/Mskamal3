// Static contract of index.html: security policy, accessibility basics,
// progressive-enhancement defaults, and "no invented facts".

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { themeTokens, readCss } from './helpers/css.js';
import { INDEX_HTML, createPage } from './helpers/dom.js';

const ROOT = new URL('../', import.meta.url);
const { document } = createPage().window;
const config = JSON.parse(readFileSync(new URL('site.config.json', ROOT), 'utf8'));
const all = (selector) => [...document.querySelectorAll(selector)];
const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');

const csp = new Map(
  document
    .querySelector('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content')
    .split(';')
    .map((directive) => directive.trim().split(/\s+/))
    .filter(([name]) => name)
    .map(([name, ...sources]) => [name, sources]),
);

describe('document basics', () => {
  test('is a standards-mode English document with the charset declared first', () => {
    assert.match(INDEX_HTML, /^<!doctype html>/i);
    assert.equal(document.documentElement.lang, 'en');
    assert.equal(document.head.firstElementChild.getAttribute('charset')?.toLowerCase(), 'utf-8');
  });

  test('is responsive and does not block pinch-zoom', () => {
    const viewport = meta('viewport');
    assert.match(viewport, /width=device-width/);
    assert.match(viewport, /initial-scale=1/);
    assert.doesNotMatch(viewport, /user-scalable\s*=\s*(no|0)|maximum-scale/);
  });

  test('has a concise title and description for search results and link previews', () => {
    const title = document.title;
    assert.ok(title.length > 0 && title.length <= 60, `title length ${title.length}`);
    const description = meta('description');
    assert.ok(description.length >= 50 && description.length <= 160, `description length ${description.length}`);
    assert.equal(document.querySelector('meta[property="og:title"]').getAttribute('content'), title);
    assert.ok(document.querySelector('meta[property="og:description"]').getAttribute('content').length > 20);
  });

  test('has exactly one h1', () => {
    assert.equal(all('h1').length, 1);
  });
});

describe('security', () => {
  test('ships a strict Content-Security-Policy', () => {
    assert.deepEqual(csp.get('default-src'), ["'none'"]);
    assert.deepEqual(csp.get('script-src'), ["'self'"]);
    assert.deepEqual(csp.get('style-src'), ["'self'"]);
    assert.deepEqual(csp.get('img-src'), ["'self'", 'data:']);
    assert.deepEqual(csp.get('connect-src'), ["'self'", 'https://api.github.com']);
    assert.deepEqual(csp.get('base-uri'), ["'none'"]);
    assert.deepEqual(csp.get('form-action'), ["'none'"]);
  });

  test('the policy never allows inline code, eval or wildcards', () => {
    for (const [name, sources] of csp) {
      for (const source of sources) {
        assert.ok(!["'unsafe-inline'", "'unsafe-eval'", '*', 'http:', 'https:'].includes(source), `${name} allows ${source}`);
      }
    }
  });

  test('contains no inline scripts, styles or event-handler attributes', () => {
    for (const script of all('script')) {
      assert.ok(script.hasAttribute('src'), 'every script must be an external file');
      assert.equal(script.textContent.trim(), '');
    }
    assert.equal(all('style').length, 0, 'no <style> elements');
    assert.equal(all('[style]').length, 0, 'no style attributes');
    const handlers = all('*').flatMap((element) => [...element.attributes].filter((attribute) => /^on/i.test(attribute.name)).map((attribute) => `${element.tagName}[${attribute.name}]`));
    assert.deepEqual(handlers, []);
  });

  test('contains no javascript: URLs', () => {
    const urls = all('[href], [src], [action]').flatMap((element) => ['href', 'src', 'action'].map((name) => element.getAttribute(name)).filter(Boolean));
    assert.deepEqual(urls.filter((url) => /^\s*javascript:/i.test(url)), []);
  });

  test('links out only to github.com, and loads nothing from other origins', () => {
    for (const link of all('a[href]')) {
      const href = link.getAttribute('href');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) assert.match(href, /^https:\/\/github\.com\//, `unexpected external link: ${href}`);
    }
    for (const element of all('script[src], link[rel~="stylesheet"][href], link[rel~="icon"][href], img[src]')) {
      const url = element.getAttribute('src') ?? element.getAttribute('href');
      assert.doesNotMatch(url, /^([a-z][a-z0-9+.-]*:)?\/\//i, `${url} must be same-origin`);
    }
    const preconnect = all('link[rel="preconnect"]').map((link) => link.getAttribute('href'));
    assert.deepEqual(preconnect, ['https://api.github.com']);
  });

  test('the stylesheet makes no network requests of its own', () => {
    const css = readCss();
    assert.doesNotMatch(css, /@import/);
    assert.doesNotMatch(css, /url\(/);
  });
});

describe('local references', () => {
  const references = all('script[src], link[href], img[src]').map((element) => element.getAttribute('src') ?? element.getAttribute('href')).filter((url) => !/^https?:/i.test(url));

  test('there are references to check', () => {
    assert.ok(references.length >= 4, `only found ${references.join(', ')}`);
  });

  test('every local file referenced exists', () => {
    for (const reference of references) assert.ok(existsSync(new URL(reference, ROOT)), `${reference} does not exist`);
  });

  test('all paths are relative, so the site also works from a /repository/ sub-path', () => {
    for (const reference of references) assert.ok(!reference.startsWith('/'), `${reference} is root-relative`);
  });

  test('theme-init.js is a blocking classic script and main.js a module', () => {
    const [first] = all('head script');
    assert.equal(first.getAttribute('src'), 'assets/js/theme-init.js');
    for (const attribute of ['type', 'defer', 'async']) assert.equal(first.hasAttribute(attribute), false, `theme-init.js must not have ${attribute}`);
    assert.equal(document.querySelector('script[src="assets/js/main.js"]').getAttribute('type'), 'module');
  });

  test('ships the empty .nojekyll marker so GitHub Pages serves the files as-is', () => {
    assert.ok(existsSync(new URL('.nojekyll', ROOT)));
  });
});

describe('structure and accessibility', () => {
  test('has banner, navigation, main and contentinfo landmarks', () => {
    for (const selector of ['body > header', 'body > header nav[aria-label]', 'main', 'body > footer']) assert.equal(all(selector).length, 1, selector);
  });

  test('ids are unique and every in-page link has a target', () => {
    const ids = all('[id]').map((element) => element.id);
    assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
    for (const link of all('a[href^="#"]')) assert.ok(document.getElementById(link.getAttribute('href').slice(1)), `${link.getAttribute('href')} has no target`);
  });

  test('the skip link is the first focusable element and jumps into main', () => {
    const first = document.querySelector('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    assert.ok(first.classList.contains('skip-link'));
    assert.ok(document.querySelector('main').contains(document.getElementById(first.getAttribute('href').slice(1))));
  });

  test('every form control has an accessible name', () => {
    for (const selector of ['#search', '#sort', '#forks']) {
      const control = document.querySelector(selector);
      const label = control.closest('label');
      assert.ok(label && label.textContent.trim().length > 0, `${selector} needs a visible or screen-reader label`);
    }
    assert.ok(document.getElementById('theme-toggle').getAttribute('aria-label'));
    assert.ok(document.getElementById('lang-filters').getAttribute('aria-label'));
    assert.ok(document.querySelector('[role="search"]').getAttribute('aria-label'));
  });

  test('decorative elements are hidden from assistive technology', () => {
    assert.equal(document.getElementById('backdrop').getAttribute('aria-hidden'), 'true');
    for (const svg of all('svg')) assert.equal(svg.getAttribute('aria-hidden'), 'true');
    for (const image of all('img')) assert.ok(image.hasAttribute('alt'));
  });

  test('the result count is a polite live region from the start', () => {
    const status = document.getElementById('result-count');
    assert.equal(status.getAttribute('role'), 'status');
    assert.equal(status.getAttribute('aria-live'), 'polite');
  });
});

describe('defaults before JavaScript runs', () => {
  test('is dark by default, with a matching browser colour', () => {
    assert.equal(document.documentElement.dataset.theme, 'dark');
    assert.equal(meta('theme-color').toLowerCase(), themeTokens('dark')['--bg'].toLowerCase());
    assert.equal(meta('color-scheme'), 'dark light');
  });

  test('controls start disabled and the grid busy, so a failed script cannot leave dead controls', () => {
    for (const selector of ['#search', '#sort', '#forks']) assert.equal(document.querySelector(selector).disabled, true, selector);
    assert.equal(document.getElementById('grid').getAttribute('aria-busy'), 'true');
  });

  test('message areas and optional sections start hidden', () => {
    for (const id of ['notice', 'state', 'langbar', 'lang-filters']) assert.equal(document.getElementById(id).hidden, true, id);
  });

  test('visitors without JavaScript are pointed to GitHub', () => {
    const fallback = document.querySelector('noscript').innerHTML;
    assert.match(fallback, new RegExp(`https://github\\.com/${config.username}\\?tab=repositories`));
  });
});

describe('content', () => {
  test('every GitHub link points at the configured account', () => {
    const links = all('a[href^="https://github.com/"]').map((link) => link.getAttribute('href'));
    assert.ok(links.length >= 3);
    for (const href of links) assert.ok(href.startsWith(`https://github.com/${config.username}`), `${href} is not under ${config.username}`);
  });

  test('the role chips are the profile tagline, which the config also hides from project cards', () => {
    const roles = all('.roles li').map((item) => item.textContent.trim());
    assert.deepEqual(roles, ['Software Developer', 'Building cool things for the web', 'Open Source Enthusiast']);
    assert.ok(config.ignoredDescriptions.includes(roles.join(' | ')), 'config.ignoredDescriptions must contain the tagline so repositories that reuse it get no duplicate text');
  });

  test('invents no contact details or other social profiles', () => {
    assert.equal(all('a[href^="mailto:"], a[href^="tel:"]').length, 0);
    assert.doesNotMatch(INDEX_HTML, /twitter\.com|x\.com|linkedin\.com|instagram\.com|facebook\.com|@[a-z0-9-]+\.(com|org|net|dev)/i);
  });

  test('has no placeholder copy', () => {
    assert.doesNotMatch(INDEX_HTML, /lorem ipsum|TODO|FIXME|your[- ]name|example\.com|placeholder text/i);
  });
});
