// Application controller: loads the config and the data, wires the controls and
// keeps the DOM in sync with the state.
//
// Everything environment-specific (document, fetch, storage, clock, matchMedia,
// the animated backdrop) is injectable, so the whole app runs under jsdom in
// the test suite exactly as it runs in a browser.

import { loadConfig } from './config.js';
import { formatDate, relativeTime } from './format.js';
import { describeError, loadRepos } from './github.js';
import { filterRepos, languageBreakdown, normalizeRepos, sortRepos, summarize } from './repos.js';
import * as view from './render.js';
import { initThemeToggle } from './theme.js';

const SORT_MODES = ['updated', 'stars', 'name'];

const REQUIRED_IDS = [
  'backdrop',
  'data-note',
  'forks',
  'grid',
  'lang-filters',
  'langbar',
  'notice',
  'projects-title',
  'result-count',
  'search',
  'sort',
  'state',
  'stats',
  'theme-toggle',
];

function collectElements(document) {
  const elements = {};
  for (const id of REQUIRED_IDS) {
    const element = document.getElementById(id);
    if (!element) throw new Error(`index.html is missing the element #${id}`);
    elements[id] = element;
  }
  return elements;
}

function defaultStorage(win) {
  try {
    return win.localStorage; // merely reading it throws when storage is blocked
  } catch {
    return undefined;
  }
}

const validSort = (value) => (SORT_MODES.includes(value) ? value : 'updated');

/**
 * @param {{
 *   document?: Document, fetch?: typeof fetch, storage?: Storage, now?: () => number,
 *   matchMedia?: (query: string) => MediaQueryList, configUrl?: string, snapshotUrl?: string,
 *   startBackdrop?: (canvas: HTMLCanvasElement) => unknown,
 * }} [env]
 * @returns {Promise<{ whenIdle: () => Promise<void> }>}
 */
export async function startApp(env = {}) {
  const document = env.document ?? globalThis.document;
  const win = document.defaultView;
  const fetchFn = env.fetch ?? globalThis.fetch.bind(globalThis);
  const storage = 'storage' in env ? env.storage : defaultStorage(win);
  const now = env.now ?? Date.now;
  const matchMedia = env.matchMedia ?? (win.matchMedia ? win.matchMedia.bind(win) : () => ({ matches: false }));
  const configUrl = env.configUrl ?? './site.config.json';
  const snapshotUrl = env.snapshotUrl ?? './data/repos.snapshot.json';

  const el = collectElements(document);
  initThemeToggle({ document, storage, matchMedia, button: el['theme-toggle'] });

  const filterControls = [el.search, el.sort, el.forks];
  const setControlsEnabled = (enabled) => {
    for (const control of filterControls) control.disabled = !enabled;
    for (const button of el['lang-filters'].querySelectorAll('button')) button.disabled = !enabled;
  };

  let config;
  try {
    config = await loadConfig({ fetch: fetchFn, url: configUrl });
  } catch (error) {
    setControlsEnabled(false);
    view.renderCards(document, el.grid, [], { now: now() });
    view.showMessage(document, el.state, {
      title: 'The site configuration could not be loaded',
      detail: error.message,
      role: 'alert',
      actions: [view.actionButton(document, 'Reload page', 'reload')],
    });
    el.state.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-action="reload"]')) win.location.reload();
    });
    return { whenIdle: () => Promise.resolve() };
  }

  if (config.backdrop && env.startBackdrop) env.startBackdrop(el.backdrop);
  else el.backdrop.hidden = true;

  // Browsers may restore form control values on reload; adopt whatever is shown.
  const state = {
    query: el.search.value,
    language: '',
    sort: validSort(el.sort.value),
    includeForks: el.forks.checked,
    repos: [],
    loading: false,
  };

  const poolSize = () => state.repos.filter((repo) => state.includeForks || !repo.isFork);

  function renderChips() {
    const languages = languageBreakdown(poolSize());
    if (!languages.some((language) => language.name.toLowerCase() === state.language.toLowerCase())) state.language = '';
    view.renderLanguageFilters(document, el['lang-filters'], languages, state.language);
    el['lang-filters'].hidden = languages.length === 0;
  }

  function renderResults() {
    const pool = poolSize();
    const shown = sortRepos(filterRepos(state.repos, state), state.sort);
    el['result-count'].textContent = view.formatResultCount(shown.length, pool.length);

    if (shown.length > 0) {
      view.hideMessage(el.state);
      view.renderCards(document, el.grid, shown, { now: now() });
      return;
    }
    view.renderCards(document, el.grid, [], { now: now() });
    if (pool.length === 0) {
      view.showMessage(document, el.state, {
        title: 'No public projects yet',
        detail: 'New work shows up here as soon as it is pushed to GitHub.',
      });
    } else {
      view.showMessage(document, el.state, {
        title: 'No projects match your filters',
        detail: 'Try a different search term or language.',
        actions: [view.actionButton(document, 'Clear filters', 'clear-filters')],
      });
    }
  }

  function clearFilters() {
    state.query = '';
    state.language = '';
    el.search.value = '';
    view.setActiveLanguage(el['lang-filters'], '');
    renderResults();
    el.search.focus();
  }

  function renderSourceInfo(result) {
    const when = relativeTime(result.fetchedAt, now());
    const date = formatDate(result.fetchedAt);
    const reason = describeError(result.error, now());
    const retry = view.actionButton(document, 'Try again', 'retry');

    switch (result.source) {
      case 'live':
        el['data-note'].textContent = 'Live from GitHub';
        view.hideMessage(el.notice);
        break;
      case 'cache':
        el['data-note'].textContent = when ? `Fetched from GitHub ${when}` : 'Fetched from GitHub';
        view.hideMessage(el.notice);
        break;
      case 'stale-cache':
        el['data-note'].textContent = when ? `Saved copy from ${when}` : 'Saved copy';
        view.showMessage(document, el.notice, {
          title: "Couldn't refresh live data",
          detail: `${reason} Showing the copy saved ${when || 'earlier'}.`,
          actions: [retry],
          role: 'status',
        });
        break;
      default:
        el['data-note'].textContent = date ? `Saved snapshot from ${date}` : 'Saved snapshot';
        view.showMessage(document, el.notice, {
          title: "Couldn't load live data",
          detail: `${reason} Showing a saved snapshot${date ? ` from ${date}` : ''}.`,
          actions: [retry],
          role: 'status',
        });
    }
  }

  async function load({ force = false, announce = false } = {}) {
    state.loading = true;
    setControlsEnabled(false);
    view.hideMessage(el.notice);
    view.hideMessage(el.state);
    view.renderSkeleton(document, el.grid);
    el['result-count'].textContent = 'Loading projects…';

    try {
      const result = await loadRepos({ username: config.username, fetch: fetchFn, storage, now, snapshotUrl, force });
      state.repos = normalizeRepos(result.repos, config);
      const summary = summarize(state.repos);
      view.renderStats(document, el.stats, summary, now());
      view.renderLanguageBar(document, el.langbar, summary.languages);
      renderChips();
      renderSourceInfo(result);
      setControlsEnabled(true);
      renderResults();
    } catch (error) {
      state.repos = [];
      el.stats.dataset.state = 'empty';
      view.renderLanguageBar(document, el.langbar, []);
      view.renderLanguageFilters(document, el['lang-filters'], [], '');
      el['lang-filters'].hidden = true;
      el['data-note'].textContent = '';
      el['result-count'].textContent = '';
      view.renderCards(document, el.grid, [], { now: now() });
      view.showMessage(document, el.state, {
        title: "Couldn't load projects",
        detail: `${describeError(error, now())} You can still browse everything on GitHub.`,
        role: 'alert',
        actions: [
          view.actionButton(document, 'Try again', 'retry'),
          view.linkButton(document, 'View on GitHub', `https://github.com/${config.username}?tab=repositories`, 'btn-ghost'),
        ],
      });
    } finally {
      state.loading = false;
      if (announce) el['projects-title'].focus({ preventScroll: true });
    }
  }

  let inflight = Promise.resolve();
  const requestLoad = (options) => {
    if (!state.loading) inflight = load(options);
    return inflight;
  };

  el.search.addEventListener('input', () => {
    state.query = el.search.value;
    renderResults();
  });
  el.sort.addEventListener('change', () => {
    state.sort = validSort(el.sort.value);
    renderResults();
  });
  el.forks.addEventListener('change', () => {
    state.includeForks = el.forks.checked;
    renderChips();
    renderResults();
  });
  el['lang-filters'].addEventListener('click', (event) => {
    const button = event.target.closest?.('button[data-language]');
    if (!button || button.disabled) return;
    const value = button.dataset.language;
    state.language = state.language.toLowerCase() === value.toLowerCase() ? '' : value;
    view.setActiveLanguage(el['lang-filters'], state.language);
    renderResults();
  });

  const onAction = (event) => {
    const button = event.target.closest?.('[data-action]');
    if (!button) return;
    if (button.dataset.action === 'retry') requestLoad({ force: true, announce: true });
    if (button.dataset.action === 'clear-filters') clearFilters();
  };
  el.notice.addEventListener('click', onAction);
  el.state.addEventListener('click', onAction);

  await requestLoad();
  return { whenIdle: () => inflight };
}
