// jsdom helpers. Pages are built from the REAL index.html, so tests fail if the
// markup and the scripts drift apart.

import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

export const INDEX_HTML = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

/**
 * A fresh jsdom window. The page's own <script> tags are NOT executed
 * ("outside-only" lets tests call window.eval themselves); tests import and
 * drive the modules directly instead.
 */
export function createPage({ html = INDEX_HTML, url = 'https://mskamal.test/' } = {}) {
  return new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
}

/**
 * A controllable window.matchMedia (jsdom has none). `set(query, matches)` flips
 * a query and notifies its "change" listeners, like the OS switching themes.
 */
export function createMatchMedia(initial = {}) {
  const state = new Map(Object.entries(initial));
  const lists = new Map();

  const matchMedia = (query) => {
    if (!lists.has(query)) {
      const listeners = new Set();
      lists.set(query, {
        media: query,
        get matches() {
          return Boolean(state.get(query));
        },
        addEventListener: (type, listener) => type === 'change' && listeners.add(listener),
        removeEventListener: (type, listener) => type === 'change' && listeners.delete(listener),
        emit: () => listeners.forEach((listener) => listener({ matches: Boolean(state.get(query)), media: query })),
        listenerCount: () => listeners.size,
      });
    }
    return lists.get(query);
  };

  return {
    matchMedia,
    set(query, matches) {
      state.set(query, matches);
      matchMedia(query).emit();
    },
    listenerCount: (query) => matchMedia(query).listenerCount(),
  };
}

const fire = (element, type) => element.dispatchEvent(new element.ownerDocument.defaultView.Event(type, { bubbles: true }));

/** Sets an input's value and fires "input", as typing does. */
export function typeInto(input, value) {
  input.value = value;
  fire(input, 'input');
}

/** Picks a <select> option and fires "change". */
export function choose(select, value) {
  select.value = value;
  fire(select, 'change');
}

/** Sets a checkbox and fires "change". */
export function setChecked(checkbox, checked) {
  checkbox.checked = checked;
  fire(checkbox, 'change');
}

/** Polls until `predicate` is truthy (for flows that settle after a few async hops). */
export async function waitFor(predicate, { timeout = 2000, interval = 4 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error('waitFor: condition was not met in time');
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
