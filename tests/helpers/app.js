// Boots the real index.html + startApp() in jsdom against stubbed network responses.

import { startApp } from '../../assets/js/app.js';
import { createMatchMedia, createPage, waitFor } from './dom.js';
import { jsonResponse, stubFetch } from './fetch.js';
import { NOW, OWNER, memoryStorage, rawRepo } from './fixtures.js';

export const testConfig = (overrides = {}) => ({
  username: OWNER,
  hiddenRepos: ['octo', 'profile'],
  ignoredDescriptions: ['generic tagline'],
  projects: { alpha: { title: 'Alpha Project', description: 'Handwritten alpha blurb.' } },
  backdrop: true,
  ...overrides,
});

/**
 * Visible by default: alpha (Go, 12 stars), Gamma (Go, 3 stars, 1 fork, homepage),
 * beta (Python, generic description), old (JavaScript, archived).
 * Hidden: `profile` (by config) and `delta-fork` (forks are off by default).
 */
export const sampleRepos = () => [
  rawRepo('alpha', { language: 'Go', pushed_at: '2026-11-03T12:00:00Z', stargazers_count: 12, topics: ['cli', 'tools'] }),
  rawRepo('beta', { language: 'Python', pushed_at: '2026-10-20T12:00:00Z', description: 'generic tagline' }),
  rawRepo('Gamma', { language: 'Go', pushed_at: '2026-10-28T12:00:00Z', stargazers_count: 3, forks_count: 1, homepage: 'https://gamma.example.com' }),
  rawRepo('delta-fork', { language: 'Rust', fork: true, pushed_at: '2026-11-01T12:00:00Z' }),
  rawRepo('profile', { language: null, pushed_at: '2026-11-04T09:00:00Z' }),
  rawRepo('old', { language: 'JavaScript', archived: true, pushed_at: '2025-01-01T00:00:00Z' }),
];

/** A snapshot that is recognisable in the UI (its only repo is `snapshot-repo`). */
export const sampleSnapshot = () => ({
  generatedAt: '2026-11-01T08:00:00.000Z',
  username: OWNER,
  repos: [rawRepo('snapshot-repo', { language: 'Go', pushed_at: '2026-10-30T00:00:00Z' })],
});

/**
 * A fetch serving the config and the snapshot, with the GitHub API delegated to
 * `api(url, init, callNumber)`, which may return a Response or throw to simulate being offline.
 * Pass `snapshot: null` to make the snapshot 404.
 */
export function siteFetch({ config = testConfig(), snapshot = sampleSnapshot(), api = () => jsonResponse(sampleRepos()) } = {}) {
  return stubFetch((url, init, callNumber) => {
    if (url.includes('site.config.json')) return config === null ? jsonResponse({}, { status: 404 }) : jsonResponse(config);
    if (url.includes('repos.snapshot.json')) return snapshot === null ? jsonResponse({}, { status: 404 }) : jsonResponse(snapshot);
    if (url.includes('api.github.com')) return api(url, init, callNumber);
    return jsonResponse({}, { status: 404 });
  });
}

export const offline = () => {
  throw new TypeError('Failed to fetch');
};

export const apiCalls = (fetch) => fetch.calls.filter((call) => call.url.includes('api.github.com'));

/**
 * @param {{ fetch?: Function, storage?: object, now?: number, prefersLight?: boolean, startBackdrop?: Function, wait?: boolean, html?: string }} [options]
 *   wait: false returns before the first load finishes, to inspect the loading state (use `started`).
 */
export async function bootApp({ fetch = siteFetch(), storage = memoryStorage(), now = NOW, prefersLight = false, startBackdrop, wait = true, html } = {}) {
  const dom = createPage(html ? { html } : {});
  const media = createMatchMedia({ '(prefers-color-scheme: light)': prefersLight });
  const document = dom.window.document;

  const started = startApp({
    document,
    fetch,
    storage,
    now: () => now,
    matchMedia: media.matchMedia,
    configUrl: './site.config.json',
    snapshotUrl: './data/repos.snapshot.json',
    startBackdrop,
  });
  if (wait) await started;

  const $ = (selector) => document.querySelector(selector);
  return {
    dom,
    window: dom.window,
    document,
    fetch,
    storage,
    media,
    started,
    $,
    $$: (selector) => [...document.querySelectorAll(selector)],
    titles: () => [...document.querySelectorAll('#grid article.card h3')].map((node) => node.textContent),
    text: (selector) => ($(selector).hidden ? '(hidden)' : $(selector).textContent.replace(/\s+/g, ' ').trim()),
    async settled() {
      const app = await started;
      await app.whenIdle();
    },
    waitFor,
  };
}
