import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatCount } from '../assets/js/format.js';
import {
  actionButton,
  formatResultCount,
  h,
  hideMessage,
  renderCard,
  renderLanguageBar,
  renderLanguageFilters,
  renderSkeleton,
  renderStats,
  setActiveLanguage,
  showMessage,
} from '../assets/js/render.js';
import { createPage } from './helpers/dom.js';
import { NOW } from './helpers/fixtures.js';

const { document } = createPage().window;

const repo = (extra = {}) => ({
  name: 'alpha',
  title: 'alpha',
  description: 'A thing',
  url: 'https://github.com/octo/alpha',
  homepage: '',
  language: 'Go',
  stars: 0,
  forks: 0,
  topics: [],
  pushedAt: Date.UTC(2026, 10, 2, 12),
  isFork: false,
  isArchived: false,
  ...extra,
});
const card = (extra, options = {}) => renderCard(document, repo(extra), { index: 0, now: NOW, ...options });
const squash = (node) => node.textContent.replace(/\s+/g, ' ').trim();

describe('h()', () => {
  test('sets attributes, treats true as a bare attribute, and skips empty values', () => {
    const node = h(document, 'a', { href: '/x', hidden: true, title: undefined, id: null, class: false, tabindex: 0 });
    assert.equal(node.getAttribute('href'), '/x');
    assert.equal(node.getAttribute('hidden'), '');
    assert.equal(node.getAttribute('tabindex'), '0');
    for (const name of ['title', 'id', 'class']) assert.equal(node.hasAttribute(name), false, name);
  });

  test('flattens arrays and skips null, undefined and false children', () => {
    const node = h(document, 'p', {}, 'a', [null, 'b', [undefined, h(document, 'b', {}, 'c')]], false);
    assert.equal(node.textContent, 'abc');
    assert.equal(node.children.length, 1);
  });

  test('inserts strings as text, never as markup', () => {
    const node = h(document, 'p', {}, '<img src=x onerror=alert(1)><b>bold</b>');
    assert.equal(node.children.length, 0);
    assert.equal(node.textContent, '<img src=x onerror=alert(1)><b>bold</b>');
  });
});

describe('renderCard', () => {
  test('links the title and the Source link to the repository', () => {
    const item = card();
    const links = [...item.querySelectorAll('a')];
    assert.equal(links[0].href, 'https://github.com/octo/alpha');
    assert.equal(links[0].textContent, 'alpha');
    assert.match(squash(links[1]), /^Source for alpha$/);
  });

  test('is a list item holding an article labelled by its title', () => {
    const item = card({}, { index: 4 });
    assert.equal(item.tagName, 'LI');
    const article = item.querySelector('article');
    assert.equal(article.getAttribute('aria-labelledby'), 'project-4-title');
    assert.equal(item.querySelector('#project-4-title').textContent, 'alpha');
  });

  test('caps the entrance-animation stagger so long lists do not wait', () => {
    assert.equal(card({}, { index: 3 }).style.getPropertyValue('--i'), '3');
    assert.equal(card({}, { index: 99 }).style.getPropertyValue('--i'), '12');
  });

  test('shows the repository name under a custom title, but not when they are identical', () => {
    assert.equal(card({ title: 'Nice Name' }).querySelector('.card-repo').textContent, 'alpha');
    assert.equal(card().querySelector('.card-repo'), null);
  });

  test('falls back to a muted placeholder when there is no description', () => {
    const node = card({ description: '' }).querySelector('.card-desc');
    assert.equal(node.textContent, 'No description yet.');
    assert.ok(node.classList.contains('is-empty'));
  });

  test('uses singular and plural screen-reader words for stars and forks', () => {
    assert.match(squash(card({ stars: 1, forks: 1 })), /1 star 1 fork(?!s)/);
    assert.match(squash(card({ stars: 2, forks: 2 })), /2 stars 2 forks/);
  });

  test('abbreviates large counts the same way as elsewhere', () => {
    assert.ok(squash(card({ stars: 1500 })).includes(`${formatCount(1500)} stars`));
  });

  test('omits zero stars and zero forks', () => {
    assert.doesNotMatch(squash(card({ stars: 0, forks: 0 })), /star|fork/i);
  });

  test('badges archived and forked repositories', () => {
    const badges = [...card({ isArchived: true, isFork: true }).querySelectorAll('.badge')].map((node) => node.textContent);
    assert.deepEqual(badges, ['Archived', 'Fork']);
    assert.equal(card().querySelectorAll('.badge').length, 0);
  });

  test('lists topics, and omits the list when there are none', () => {
    assert.deepEqual([...card({ topics: ['cli', 'tools'] }).querySelectorAll('.topics li')].map((node) => node.textContent), ['cli', 'tools']);
    assert.equal(card().querySelector('.topics'), null);
  });

  test('shows a machine-readable, titled "Updated" time', () => {
    const time = card().querySelector('time');
    assert.equal(time.getAttribute('datetime'), '2026-11-02T12:00:00.000Z');
    assert.equal(time.getAttribute('title'), 'Nov 2, 2026');
    assert.match(time.textContent, /^Updated .*ago$/);
  });

  test('omits the time when the push date is unknown', () => {
    assert.equal(card({ pushedAt: 0 }).querySelector('time'), null);
    assert.equal(card({ pushedAt: Number.NaN }).querySelector('time'), null);
  });

  test('shows the language with a colour dot, or nothing for repos without one', () => {
    const meta = card().querySelector('.card-meta');
    assert.match(meta.textContent, /Go/);
    assert.ok(meta.querySelector('.dot').style.getPropertyValue('--c').length > 0);
    assert.doesNotMatch(card({ language: '' }).querySelector('.card-meta').textContent, /Go/);
  });

  test('adds a hardened live-site link only when a homepage exists', () => {
    assert.equal([...card().querySelectorAll('a')].some((a) => a.textContent.startsWith('Live site')), false);
    const link = [...card({ homepage: 'https://example.com/' }).querySelectorAll('a')].find((a) => a.textContent.startsWith('Live site'));
    assert.equal(link.href, 'https://example.com/');
    assert.equal(link.rel, 'noopener noreferrer');
  });

  test('every decorative icon is hidden from assistive technology', () => {
    const icons = [...card({ stars: 1, forks: 1, homepage: 'https://example.com/' }).querySelectorAll('svg')];
    assert.ok(icons.length >= 3);
    for (const icon of icons) {
      assert.equal(icon.getAttribute('aria-hidden'), 'true');
      assert.equal(icon.getAttribute('focusable'), 'false');
    }
  });
});

describe('renderSkeleton', () => {
  test('fills the grid with hidden placeholder cards and marks it busy', () => {
    const grid = document.createElement('ul');
    renderSkeleton(document, grid);
    assert.equal(grid.children.length, 3);
    assert.ok([...grid.children].every((item) => item.getAttribute('aria-hidden') === 'true'));
    assert.equal(grid.getAttribute('aria-busy'), 'true');
    renderSkeleton(document, grid, 5);
    assert.equal(grid.children.length, 5);
  });
});

describe('renderStats', () => {
  const container = () => document.createElement('dl');
  const summary = (extra = {}) => ({ count: 3, stars: 0, languages: [{ name: 'Go' }], lastPushAt: Date.UTC(2026, 10, 3), ...extra });
  const labels = (dl) => [...dl.querySelectorAll('dt')].map((node) => node.textContent);

  test('lists the stats that have something to say, in a stable order', () => {
    const dl = container();
    renderStats(document, dl, summary({ stars: 7 }), NOW);
    assert.deepEqual(labels(dl), ['Projects', 'Languages', 'Stars', 'Last push']);
    assert.equal(dl.dataset.state, 'ready');
  });

  test('drops Languages, Stars and Last push when they have nothing to show', () => {
    const dl = container();
    renderStats(document, dl, summary({ languages: [], lastPushAt: 0 }), NOW);
    assert.deepEqual(labels(dl), ['Projects']);
  });

  test('marks an empty account so the strip can be hidden', () => {
    const dl = container();
    renderStats(document, dl, summary({ count: 0, languages: [], lastPushAt: 0 }), NOW);
    assert.equal(dl.dataset.state, 'empty');
  });
});

describe('renderLanguageBar', () => {
  test('is hidden and empty without languages', () => {
    const box = document.createElement('div');
    renderLanguageBar(document, box, []);
    assert.equal(box.hidden, true);
    assert.equal(box.children.length, 0);
  });

  test('sizes each segment by its share and describes the whole bar once', () => {
    const box = document.createElement('div');
    renderLanguageBar(document, box, [
      { name: 'Go', count: 2, share: 2 / 3, color: '#00add8' },
      { name: 'Python', count: 1, share: 1 / 3, color: '#3572a5' },
    ]);
    assert.equal(box.hidden, false);
    const segments = [...box.querySelectorAll('.langbar-seg')];
    assert.deepEqual(segments.map((s) => s.style.getPropertyValue('--w')), ['66.67%', '33.33%']);
    assert.deepEqual(segments.map((s) => s.style.getPropertyValue('--c')), ['#00add8', '#3572a5']);
    assert.equal(box.querySelector('[role="img"]').getAttribute('aria-label'), 'Languages by number of projects: Go 2, Python 1');
  });
});

describe('renderLanguageFilters', () => {
  test('renders "All" first and marks the active language case-insensitively', () => {
    const box = document.createElement('div');
    renderLanguageFilters(document, box, [{ name: 'Go', count: 2 }, { name: 'Python', count: 1 }], 'python');
    const pressed = [...box.querySelectorAll('button')].map((button) => `${button.dataset.language || 'All'}:${button.getAttribute('aria-pressed')}`);
    assert.deepEqual(pressed, ['All:false', 'Go:false', 'Python:true']);

    setActiveLanguage(box, '');
    assert.equal(box.querySelector('button[data-language=""]').getAttribute('aria-pressed'), 'true');
    assert.ok([...box.querySelectorAll('button')].every((button) => button.getAttribute('type') === 'button'));
  });
});

describe('formatResultCount', () => {
  test('pluralises and shows "x of y" only when filtering', () => {
    assert.equal(formatResultCount(5, 5), '5 projects');
    assert.equal(formatResultCount(1, 1), '1 project');
    assert.equal(formatResultCount(0, 0), '0 projects');
    assert.equal(formatResultCount(2, 5), '2 of 5 projects');
    assert.equal(formatResultCount(1, 5), '1 of 5 projects');
    assert.equal(formatResultCount(0, 5), '0 of 5 projects');
  });
});

describe('showMessage / hideMessage', () => {
  test('fills the container, applies the role, and shows it', () => {
    const box = document.createElement('div');
    box.hidden = true;
    showMessage(document, box, { title: 'Oops', detail: 'Details here', actions: [actionButton(document, 'Retry', 'retry')], role: 'alert' });
    assert.equal(box.hidden, false);
    assert.equal(box.getAttribute('role'), 'alert');
    assert.equal(box.querySelector('.message-title').textContent, 'Oops');
    assert.equal(box.querySelector('.message-detail').textContent, 'Details here');
    assert.equal(box.querySelector('button').dataset.action, 'retry');
    assert.equal(box.querySelector('button').type, 'button');
  });

  test('drops a previous role when the next message has none, and omits empty parts', () => {
    const box = document.createElement('div');
    showMessage(document, box, { title: 'First', role: 'alert' });
    showMessage(document, box, { detail: 'Only detail' });
    assert.equal(box.hasAttribute('role'), false);
    assert.equal(box.querySelector('.message-title'), null);
    assert.equal(box.querySelector('.message-actions'), null);
  });

  test('hideMessage empties and hides it', () => {
    const box = document.createElement('div');
    showMessage(document, box, { title: 'x' });
    hideMessage(box);
    assert.equal(box.hidden, true);
    assert.equal(box.children.length, 0);
  });
});
