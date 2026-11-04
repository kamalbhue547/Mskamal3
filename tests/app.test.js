// End-to-end behaviour of the page in jsdom: the real index.html, the real
// startApp(), and stubbed network responses.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { relativeTime } from '../assets/js/format.js';
import { writeCache } from '../assets/js/github.js';
import { pickRepoFields } from '../assets/js/repos.js';
import { apiCalls, bootApp, offline, sampleRepos, siteFetch, testConfig } from './helpers/app.js';
import { INDEX_HTML, choose, setChecked, typeInto } from './helpers/dom.js';
import { jsonResponse } from './helpers/fetch.js';
import { NOW, OWNER, memoryStorage, rawRepo } from './helpers/fixtures.js';

const at = (iso) => Date.parse(iso);
const rateLimited = () =>
  jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + 25 * 60) } });

describe('initial load', () => {
  test('renders one card per visible project, newest first, replacing the skeleton', async () => {
    const page = await bootApp();
    assert.deepEqual(page.titles(), ['Alpha Project', 'Gamma', 'beta', 'old']);
    assert.equal(page.$('#grid').getAttribute('aria-busy'), 'false');
    assert.equal(page.$$('#grid .card-skeleton').length, 0);
  });

  test('applies config overrides, shows the repo name, and ignores the shared tagline', async () => {
    const page = await bootApp();
    const [alpha, , beta] = page.$$('#grid article.card');
    assert.equal(alpha.querySelector('.card-repo').textContent, 'alpha');
    assert.equal(alpha.querySelector('.card-desc').textContent, 'Handwritten alpha blurb.');
    assert.equal(beta.querySelector('.card-desc').textContent, 'No description yet.');
    assert.ok(beta.querySelector('.card-desc').classList.contains('is-empty'));
  });

  test('never lists hidden repositories or (by default) forks', async () => {
    const page = await bootApp();
    assert.ok(!page.titles().includes('profile'));
    assert.ok(!page.titles().includes('delta-fork'));
  });

  test('shows the profile stats: projects, languages, stars and the last push', async () => {
    const page = await bootApp();
    const stats = Object.fromEntries(page.$$('#stats .stat').map((stat) => [stat.querySelector('dt').textContent, stat.querySelector('dd').textContent]));
    assert.deepEqual(stats, { Projects: '4', Languages: '3', Stars: '15', 'Last push': relativeTime(at('2026-11-03T12:00:00Z'), NOW) });
    assert.equal(page.$('#stats').dataset.state, 'ready');
  });

  test('omits the Stars stat while nothing has any stars', async () => {
    const page = await bootApp({ fetch: siteFetch({ api: () => jsonResponse([rawRepo('a'), rawRepo('b', { language: 'Go' })]) }) });
    const labels = page.$$('#stats dt').map((node) => node.textContent);
    assert.deepEqual(labels, ['Projects', 'Languages', 'Last push']);
  });

  test('describes the language mix to assistive technology and as a legend', async () => {
    const page = await bootApp();
    const bar = page.$('#langbar [role="img"]');
    assert.equal(bar.getAttribute('aria-label'), 'Languages by number of projects: Go 2, JavaScript 1, Python 1');
    assert.equal(page.$$('#langbar .langbar-seg').length, 3);
    assert.equal(page.$$('#langbar .langlegend li').length, 3);
    assert.equal(page.$('#langbar').hidden, false);
  });

  test('offers an "All" chip plus one per language, most used first', async () => {
    const page = await bootApp();
    const chips = page.$$('#lang-filters button');
    assert.deepEqual(chips.map((chip) => chip.dataset.language), ['', 'Go', 'JavaScript', 'Python']);
    assert.deepEqual(chips.map((chip) => chip.getAttribute('aria-pressed')), ['true', 'false', 'false', 'false']);
  });

  test('announces the result count and the data source', async () => {
    const page = await bootApp();
    assert.equal(page.text('#result-count'), '4 projects');
    assert.equal(page.$('#result-count').getAttribute('role'), 'status');
    assert.equal(page.text('#data-note'), 'Live from GitHub');
    assert.equal(page.text('#notice'), '(hidden)');
    assert.equal(page.text('#state'), '(hidden)');
  });

  test('keeps controls disabled and shows a skeleton until the data arrives', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    const fetch = siteFetch({ api: async () => (await gate, jsonResponse(sampleRepos())) });
    const page = await bootApp({ fetch, wait: false });

    try {
      // The grid is aria-busy in the static HTML already, so wait for the skeleton cards themselves.
      await page.waitFor(() => page.$$('#grid .card-skeleton').length > 0);
      assert.equal(page.$('#grid').getAttribute('aria-busy'), 'true');
      assert.equal(page.text('#result-count'), 'Loading projects…');
      for (const selector of ['#search', '#sort', '#forks']) assert.equal(page.$(selector).disabled, true, `${selector} should be disabled while loading`);
    } finally {
      release(); // never leave the request pending: it would keep the test process alive
    }

    await page.started;
    assert.equal(page.$$('#grid .card-skeleton').length, 0);
    for (const selector of ['#search', '#sort', '#forks']) assert.equal(page.$(selector).disabled, false);
  });

  test('a second visit within the cache window is served locally', async () => {
    const storage = memoryStorage();
    const first = siteFetch();
    await bootApp({ fetch: first, storage });
    assert.equal(apiCalls(first).length, 1);

    const second = siteFetch();
    const page = await bootApp({ fetch: second, storage });
    assert.equal(apiCalls(second).length, 0);
    assert.equal(page.text('#data-note'), `Fetched from GitHub ${relativeTime(NOW, NOW)}`);
    assert.deepEqual(page.titles(), ['Alpha Project', 'Gamma', 'beta', 'old']);
  });

  test('every card is labelled by its own, unique heading', async () => {
    const page = await bootApp();
    const ids = new Set();
    for (const card of page.$$('#grid article.card')) {
      const id = card.getAttribute('aria-labelledby');
      assert.ok(!ids.has(id), `duplicate id ${id}`);
      ids.add(id);
      assert.equal(page.document.getElementById(id).closest('h3').textContent, card.querySelector('h3').textContent);
    }
  });

  test('card links point at the right places and external ones are hardened', async () => {
    const page = await bootApp();
    const gamma = page.$$('#grid article.card').find((card) => card.querySelector('h3').textContent === 'Gamma');
    const source = [...gamma.querySelectorAll('a.link')].find((a) => a.textContent.startsWith('Source'));
    const live = [...gamma.querySelectorAll('a.link')].find((a) => a.textContent.startsWith('Live site'));
    assert.equal(source.href, `https://github.com/${OWNER}/Gamma`);
    assert.equal(new URL(live.href).hostname, 'gamma.example.com');
    assert.match(live.rel, /noopener/);
    assert.match(live.rel, /noreferrer/);
  });

  test('shows stars and forks only when they are above zero, with screen-reader words', async () => {
    const page = await bootApp();
    const [alpha, gamma, beta] = page.$$('#grid article.card');
    assert.match(alpha.textContent, /12\s*stars/);
    assert.doesNotMatch(alpha.textContent, /fork/i);
    assert.match(gamma.textContent, /3\s*stars/);
    assert.match(gamma.textContent, /1\s*fork(?!s)/);
    assert.doesNotMatch(beta.textContent, /star|fork/i);
  });

  test('marks archived repositories', async () => {
    const page = await bootApp();
    const old = page.$$('#grid article.card').find((card) => card.querySelector('h3').textContent === 'old');
    assert.match(old.querySelector('.badge').textContent, /Archived/);
  });
});

describe('searching, filtering and sorting', () => {
  test('search matches title, repo name, description, language and topics, ignoring case and spacing', async () => {
    const page = await bootApp();
    const search = page.$('#search');
    for (const [query, expected] of [
      ['  ALPHA ', ['Alpha Project']],
      ['handwritten', ['Alpha Project']],
      ['tools', ['Alpha Project']],
      ['python', ['beta']],
      ['gamma example', []], // homepage is not searchable, so both terms must match elsewhere
    ]) {
      typeInto(search, query);
      assert.deepEqual(page.titles(), expected, `query ${JSON.stringify(query)}`);
    }
  });

  test('the result count reflects the filter', async () => {
    const page = await bootApp();
    typeInto(page.$('#search'), 'alpha');
    assert.equal(page.text('#result-count'), '1 of 4 projects');
  });

  test('language chips filter, show their pressed state, and toggle off again', async () => {
    const page = await bootApp();
    const go = page.$('#lang-filters button[data-language="Go"]');
    go.click();
    assert.deepEqual(page.titles(), ['Alpha Project', 'Gamma']);
    assert.equal(go.getAttribute('aria-pressed'), 'true');
    assert.equal(page.text('#result-count'), '2 of 4 projects');
    go.click();
    assert.equal(page.titles().length, 4);
    assert.equal(go.getAttribute('aria-pressed'), 'false');
    assert.equal(page.$('#lang-filters button[data-language=""]').getAttribute('aria-pressed'), 'true');
  });

  test('search and language filters combine', async () => {
    const page = await bootApp();
    page.$('#lang-filters button[data-language="Go"]').click();
    typeInto(page.$('#search'), 'gamma');
    assert.deepEqual(page.titles(), ['Gamma']);
  });

  test('sorts by name (using the displayed titles), stars and recency', async () => {
    const page = await bootApp();
    choose(page.$('#sort'), 'name');
    assert.deepEqual(page.titles(), ['Alpha Project', 'beta', 'Gamma', 'old']);
    choose(page.$('#sort'), 'stars');
    assert.deepEqual(page.titles(), ['Alpha Project', 'Gamma', 'beta', 'old']);
    choose(page.$('#sort'), 'updated');
    assert.deepEqual(page.titles(), ['Alpha Project', 'Gamma', 'beta', 'old']);
  });

  test('sorting by name follows the title shown on the card, not the repository slug', async () => {
    const config = testConfig({ projects: { alpha: { title: 'Zulu Project' } } });
    const page = await bootApp({ fetch: siteFetch({ config }) });
    choose(page.$('#sort'), 'name');
    assert.deepEqual(page.titles(), ['beta', 'Gamma', 'old', 'Zulu Project']);
  });

  test('forks can be included, are badged, and add their language to the chips', async () => {
    const page = await bootApp();
    setChecked(page.$('#forks'), true);
    assert.deepEqual(page.titles(), ['Alpha Project', 'delta-fork', 'Gamma', 'beta', 'old']);
    const fork = page.$$('#grid article.card')[1];
    assert.match(fork.querySelector('.badge').textContent, /Fork/);
    assert.ok(page.$('#lang-filters button[data-language="Rust"]'));
    assert.equal(page.text('#result-count'), '5 projects');
  });

  test('a language filter that disappears with the forks is reset instead of leaving an empty page', async () => {
    const page = await bootApp();
    setChecked(page.$('#forks'), true);
    page.$('#lang-filters button[data-language="Rust"]').click();
    assert.deepEqual(page.titles(), ['delta-fork']);

    setChecked(page.$('#forks'), false);
    assert.equal(page.titles().length, 4);
    assert.equal(page.$('#lang-filters button[data-language=""]').getAttribute('aria-pressed'), 'true');
    assert.equal(page.$('#lang-filters button[data-language="Rust"]'), null);
  });

  test('no matches shows an empty state whose button clears every filter and focuses the search box', async () => {
    const page = await bootApp();
    page.$('#lang-filters button[data-language="Go"]').click();
    typeInto(page.$('#search'), 'zzzz-nothing');

    assert.deepEqual(page.titles(), []);
    assert.match(page.text('#state'), /No projects match your filters/);
    assert.equal(page.text('#result-count'), '0 of 4 projects');

    page.$('#state [data-action="clear-filters"]').click();
    assert.equal(page.titles().length, 4);
    assert.equal(page.$('#search').value, '');
    assert.equal(page.text('#state'), '(hidden)');
    assert.equal(page.document.activeElement, page.$('#search'));
    assert.equal(page.$('#lang-filters button[data-language=""]').getAttribute('aria-pressed'), 'true');
  });

  test('an account with no public projects says so, without offering to clear filters', async () => {
    const page = await bootApp({ fetch: siteFetch({ api: () => jsonResponse([]) }) });
    assert.match(page.text('#state'), /No public projects yet/);
    assert.equal(page.$('#state [data-action="clear-filters"]'), null);
    assert.equal(page.$('#stats').dataset.state, 'empty');
    assert.equal(page.text('#result-count'), '0 projects');
  });
});

describe('when GitHub cannot be reached', () => {
  test('a rate limit falls back to the snapshot and says when it resets', async () => {
    const page = await bootApp({ fetch: siteFetch({ api: rateLimited }) });
    assert.deepEqual(page.titles(), ['snapshot-repo']);
    assert.match(page.text('#notice'), /Couldn't load live data/);
    assert.match(page.text('#notice'), /rate limit was reached; it resets in about 25 minutes/);
    assert.match(page.text('#notice'), /saved snapshot from Nov 1, 2026/);
    assert.equal(page.text('#data-note'), 'Saved snapshot from Nov 1, 2026');
    assert.ok(page.$('#notice [data-action="retry"]'));
    assert.equal(page.$('#notice').getAttribute('role'), 'status');
  });

  test('an expired cache is preferred over the snapshot and its age is stated', async () => {
    const storage = memoryStorage();
    writeCache(storage, OWNER, sampleRepos().map(pickRepoFields), NOW - 3 * 60 * 60 * 1000);
    const page = await bootApp({ fetch: siteFetch({ api: offline }), storage });
    assert.deepEqual(page.titles(), ['Alpha Project', 'Gamma', 'beta', 'old']);
    assert.match(page.text('#notice'), /Couldn't refresh live data/);
    assert.match(page.text('#notice'), /Check your connection\. Showing the copy saved 3 hours ago\./);
    assert.equal(page.text('#data-note'), 'Saved copy from 3 hours ago');
  });

  test('with nothing to show it explains, links to GitHub, disables the controls, and can retry', async () => {
    let down = true;
    const fetch = siteFetch({ snapshot: null, api: () => (down ? offline() : jsonResponse(sampleRepos())) });
    const page = await bootApp({ fetch });

    const alert = page.$('#state');
    assert.equal(alert.getAttribute('role'), 'alert');
    assert.match(page.text('#state'), /Couldn't load projects/);
    assert.match(page.text('#state'), /GitHub couldn't be reached/);
    assert.equal(alert.querySelector('a').href, `https://github.com/${OWNER}?tab=repositories`);
    assert.equal(page.$('#search').disabled, true);
    assert.equal(page.$('#grid').getAttribute('aria-busy'), 'false');
    assert.equal(page.$$('#grid li').length, 0);

    down = false;
    alert.querySelector('[data-action="retry"]').click();
    await page.settled();
    assert.equal(page.titles().length, 4);
    assert.equal(page.text('#state'), '(hidden)');
    assert.equal(page.$('#search').disabled, false);
  });

  test('retry from the snapshot banner loads live data and moves focus to the projects heading', async () => {
    let down = true;
    const fetch = siteFetch({ api: () => (down ? rateLimited() : jsonResponse(sampleRepos())) });
    const page = await bootApp({ fetch });
    assert.deepEqual(page.titles(), ['snapshot-repo']);

    down = false;
    page.$('#notice [data-action="retry"]').click();
    await page.settled();
    assert.equal(page.titles().length, 4);
    assert.equal(page.text('#notice'), '(hidden)');
    assert.equal(page.text('#data-note'), 'Live from GitHub');
    assert.equal(page.document.activeElement, page.$('#projects-title'));
  });

  test('clicking retry repeatedly makes a single request', async () => {
    let down = true;
    const fetch = siteFetch({ api: () => (down ? offline() : jsonResponse(sampleRepos())) });
    const page = await bootApp({ fetch });
    const before = apiCalls(fetch).length;

    down = false;
    const retry = page.$('#notice [data-action="retry"]');
    retry.click();
    retry.click();
    retry.click();
    await page.settled();
    assert.equal(apiCalls(fetch).length - before, 1);
  });

  test('controls are disabled again, with a skeleton, while a retry is in flight', async () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    let attempt = 0;
    const fetch = siteFetch({
      api: async () => {
        attempt += 1;
        if (attempt === 1) return rateLimited();
        await gate;
        return jsonResponse(sampleRepos());
      },
    });
    const page = await bootApp({ fetch });
    for (const selector of ['#search', '#sort', '#forks']) assert.equal(page.$(selector).disabled, false, 'enabled before retrying');

    page.$('#notice [data-action="retry"]').click();
    try {
      assert.ok(page.$$('#grid .card-skeleton').length > 0);
      assert.equal(page.text('#result-count'), 'Loading projects…');
      for (const selector of ['#search', '#sort', '#forks']) assert.equal(page.$(selector).disabled, true, `${selector} should be disabled during the retry`);
      assert.ok(page.$$('#lang-filters button').every((button) => button.disabled), 'language chips should be disabled during the retry');
    } finally {
      release();
    }
    await page.settled();
    for (const selector of ['#search', '#sort', '#forks']) assert.equal(page.$(selector).disabled, false);
  });

  test('"Try again" always asks GitHub again, even if another tab just refreshed the cache', async () => {
    const fetch = siteFetch({ api: offline });
    const page = await bootApp({ fetch });
    const before = apiCalls(fetch).length;

    writeCache(page.storage, OWNER, sampleRepos().map(pickRepoFields), NOW); // as if written by another tab a moment ago
    page.$('#notice [data-action="retry"]').click();
    await page.settled();
    assert.equal(apiCalls(fetch).length - before, 1);
  });

  test('a failure while retrying returns to the fallback view instead of getting stuck loading', async () => {
    const fetch = siteFetch({ api: offline });
    const page = await bootApp({ fetch });
    page.$('#notice [data-action="retry"]').click();
    await page.settled();
    assert.deepEqual(page.titles(), ['snapshot-repo']);
    assert.ok(page.$('#notice [data-action="retry"]'));
    assert.equal(page.$('#grid').getAttribute('aria-busy'), 'false');
    assert.equal(page.$('#search').disabled, false);
  });

  test('an unreadable site config is reported instead of leaving a blank page', async () => {
    const fetch = siteFetch({ config: null });
    const page = await bootApp({ fetch });
    assert.equal(page.$('#state').getAttribute('role'), 'alert');
    assert.match(page.text('#state'), /site configuration could not be loaded/);
    assert.equal(apiCalls(fetch).length, 0);
    assert.equal(page.$('#search').disabled, true);
  });

  test('a page missing a required element fails loudly with its name', async () => {
    const html = INDEX_HTML.replace('id="grid"', 'id="not-the-grid"');
    await assert.rejects(bootApp({ html }), /missing the element #grid/);
  });
});

describe('untrusted data', () => {
  const hostile = () => [
    rawRepo('hostile', {
      html_url: `https://github.com/${OWNER}/hostile`,
      description: '<img src=x onerror="window.pwned = 1"><script>window.pwned = 2</script><b>bold</b>',
      topics: ['<svg onload="window.pwned = 3">'],
      language: '<i>Evil</i>',
      homepage: 'javascript:window.pwned = 4',
    }),
    rawRepo('script-link', { html_url: 'javascript:window.pwned = 5' }),
    rawRepo('fine', { homepage: 'https://fine.example.com' }),
  ];

  test('markup in API fields is shown as text and never becomes elements', async () => {
    const page = await bootApp({ fetch: siteFetch({ api: () => jsonResponse(hostile()) }) });
    assert.equal(page.$$('#grid img, #grid script, #grid b, #grid i, #grid [onerror], #grid [onload]').length, 0);
    assert.equal(page.window.pwned, undefined);

    const card = page.$$('#grid article.card').find((node) => node.querySelector('h3').textContent === 'hostile');
    assert.match(card.querySelector('.card-desc').textContent, /<script>window\.pwned = 2<\/script>/);
    assert.equal(card.querySelector('.topics li').textContent, '<svg onload="window.pwned = 3">');
  });

  test('no javascript: URL ever reaches an href, and repos with one are dropped', async () => {
    const page = await bootApp({ fetch: siteFetch({ api: () => jsonResponse(hostile()) }) });
    assert.deepEqual(page.titles().sort(), ['fine', 'hostile']);
    const hrefs = page.$$('a[href]').map((a) => a.getAttribute('href'));
    assert.equal(hrefs.filter((href) => /^\s*javascript:/i.test(href)).length, 0);
    const hostileCard = page.$$('#grid article.card').find((node) => node.querySelector('h3').textContent === 'hostile');
    assert.ok(![...hostileCard.querySelectorAll('a')].some((a) => a.textContent.startsWith('Live site')), 'the javascript: homepage must be dropped');
  });
});

describe('theme, backdrop and configuration wiring', () => {
  test('follows the system theme on first load', async () => {
    const page = await bootApp({ prefersLight: true });
    assert.equal(page.document.documentElement.dataset.theme, 'light');
    assert.equal(page.$('#theme-toggle').getAttribute('aria-label'), 'Switch to dark theme');
  });

  test('the toggle switches themes and remembers the choice', async () => {
    const storage = memoryStorage();
    const page = await bootApp({ storage });
    page.$('#theme-toggle').click();
    assert.equal(page.document.documentElement.dataset.theme, 'light');
    assert.equal(storage.getItem('mskamal3:theme'), 'light');
  });

  test('starts the backdrop with its canvas when the config allows it', async () => {
    const started = [];
    const page = await bootApp({ startBackdrop: (canvas) => started.push(canvas) });
    assert.deepEqual(started, [page.$('#backdrop')]);
    assert.equal(page.$('#backdrop').hidden, false);
  });

  test('hides the canvas when the config turns the backdrop off', async () => {
    const started = [];
    const fetch = siteFetch({ config: testConfig({ backdrop: false }) });
    const page = await bootApp({ fetch, startBackdrop: (canvas) => started.push(canvas) });
    assert.equal(started.length, 0);
    assert.equal(page.$('#backdrop').hidden, true);
  });

  test('queries GitHub for the configured user only', async () => {
    const fetch = siteFetch({ config: testConfig({ username: 'someone-else' }) });
    await bootApp({ fetch });
    assert.match(apiCalls(fetch)[0].url, /\/users\/someone-else\/repos/);
  });
});
