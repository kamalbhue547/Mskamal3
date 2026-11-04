// DOM rendering. Everything is built with createElement/textContent, never
// innerHTML, so text coming from the GitHub API can never inject markup.

import { formatCount, formatDate, isoDate, pluralize, relativeTime } from './format.js';
import { languageColor } from './repos.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Hyperscript-style helper: h(document, 'a', { href }, 'text', childNode). */
export function h(document, tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== undefined && child !== null && child !== false) node.append(child);
  }
  return node;
}

const ICONS = {
  star: [['path', { d: 'M8 1.6l1.9 4.1 4.5.5-3.3 3.1.9 4.4L8 11.4l-4 2.3.9-4.4L1.6 6.2l4.5-.5z' }]],
  fork: [
    ['circle', { cx: 4.5, cy: 3, r: 1.5 }],
    ['circle', { cx: 11.5, cy: 3, r: 1.5 }],
    ['circle', { cx: 8, cy: 13, r: 1.5 }],
    ['path', { d: 'M4.5 4.5v1.2c0 1 .8 1.8 1.8 1.8h3.4c1 0 1.8-.8 1.8-1.8V4.5M8 7.5v4' }],
  ],
  code: [['path', { d: 'M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5' }]],
  external: [['path', { d: 'M9 2.5h4.5V7M13.5 2.5L7 9M12 9.5v2.5a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 12V6a1.5 1.5 0 0 1 1.5-1.5H7' }]],
};

export function icon(document, name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  for (const [tag, attrs] of ICONS[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) shape.setAttribute(key, String(value));
    svg.append(shape);
  }
  return svg;
}

/** [a, b, c] -> [a, ' ', b, ' ', c] */
const joinWithSpaces = (items) => items.flatMap((item, index) => (index === 0 ? [item] : [' ', item]));

const screenReaderText = (document, text) => h(document, 'span', { class: 'sr-only' }, text);

function colorDot(document, language) {
  const dot = h(document, 'span', { class: 'dot', 'aria-hidden': 'true' });
  dot.style.setProperty('--c', languageColor(language));
  return dot;
}

/** One project card, as a list item. */
export function renderCard(document, repo, { index, now }) {
  const titleId = `project-${index}-title`;
  const item = h(document, 'li', { class: 'card-item' });
  item.style.setProperty('--i', String(Math.min(index, 12)));

  const title = h(document, 'h3', { class: 'card-title' }, h(document, 'a', { href: repo.url, id: titleId }, repo.title));
  const head = h(document, 'div', { class: 'card-head' }, title);
  if (repo.isArchived) head.append(h(document, 'span', { class: 'badge' }, 'Archived'));
  if (repo.isFork) head.append(h(document, 'span', { class: 'badge' }, 'Fork'));

  const body = [head];
  if (repo.title !== repo.name) body.push(h(document, 'p', { class: 'card-repo' }, repo.name));
  body.push(
    repo.description
      ? h(document, 'p', { class: 'card-desc' }, repo.description)
      : h(document, 'p', { class: 'card-desc is-empty' }, 'No description yet.'),
  );

  if (repo.topics.length > 0) {
    body.push(
      h(
        document,
        'ul',
        { class: 'topics', 'aria-label': 'Topics' },
        repo.topics.map((topic) => h(document, 'li', {}, topic)),
      ),
    );
  }

  const metaItems = [];
  if (repo.language) metaItems.push(h(document, 'span', { class: 'meta-item' }, colorDot(document, repo.language), repo.language));
  if (repo.stars > 0) {
    metaItems.push(h(document, 'span', { class: 'meta-item' }, icon(document, 'star'), formatCount(repo.stars), screenReaderText(document, repo.stars === 1 ? ' star' : ' stars')));
  }
  if (repo.forks > 0) {
    metaItems.push(h(document, 'span', { class: 'meta-item' }, icon(document, 'fork'), formatCount(repo.forks), screenReaderText(document, repo.forks === 1 ? ' fork' : ' forks')));
  }
  const updated = relativeTime(repo.pushedAt, now);
  if (updated) {
    metaItems.push(h(document, 'time', { class: 'meta-item meta-time', datetime: isoDate(repo.pushedAt), title: formatDate(repo.pushedAt) }, `Updated ${updated}`));
  }
  // Whitespace between the items is invisible in the flex layout but keeps the text readable on its own.
  const meta = h(document, 'div', { class: 'card-meta' }, joinWithSpaces(metaItems));
  body.push(meta);

  const linkItems = [h(document, 'a', { class: 'link', href: repo.url }, icon(document, 'code'), 'Source', screenReaderText(document, ` for ${repo.title}`))];
  if (repo.homepage) {
    linkItems.push(h(document, 'a', { class: 'link', href: repo.homepage, rel: 'noopener noreferrer' }, icon(document, 'external'), 'Live site', screenReaderText(document, ` for ${repo.title}`)));
  }
  body.push(h(document, 'div', { class: 'card-links' }, joinWithSpaces(linkItems)));

  item.append(h(document, 'article', { class: 'card', 'aria-labelledby': titleId }, body));
  return item;
}

export function renderCards(document, grid, repos, { now }) {
  grid.replaceChildren(...repos.map((repo, index) => renderCard(document, repo, { index, now })));
  grid.setAttribute('aria-busy', 'false');
}

export function renderSkeleton(document, grid, count = 3) {
  const cards = Array.from({ length: count }, (_, index) => {
    const item = h(document, 'li', { class: 'card-item', 'aria-hidden': 'true' }, h(document, 'div', { class: 'card card-skeleton' }, h(document, 'span', { class: 'skeleton-line is-title' }), h(document, 'span', { class: 'skeleton-line' }), h(document, 'span', { class: 'skeleton-line is-short' })));
    item.style.setProperty('--i', String(index));
    return item;
  });
  grid.replaceChildren(...cards);
  grid.setAttribute('aria-busy', 'true');
}

export function renderStats(document, container, summary, now) {
  const items = [['Projects', String(summary.count)]];
  if (summary.languages.length > 0) items.push(['Languages', String(summary.languages.length)]);
  if (summary.stars > 0) items.push(['Stars', formatCount(summary.stars)]);
  const lastPush = relativeTime(summary.lastPushAt, now);
  if (lastPush) items.push(['Last push', lastPush]);

  container.replaceChildren(
    ...items.map(([label, value]) => h(document, 'div', { class: 'stat' }, h(document, 'dt', { class: 'stat-label' }, label), h(document, 'dd', { class: 'stat-value' }, value))),
  );
  container.dataset.state = summary.count > 0 ? 'ready' : 'empty';
}

export function renderLanguageBar(document, container, languages) {
  container.replaceChildren();
  container.hidden = languages.length === 0;
  if (languages.length === 0) return;

  const description = `Languages by number of projects: ${languages.map((language) => `${language.name} ${language.count}`).join(', ')}`;
  const bar = h(document, 'div', { class: 'langbar', role: 'img', 'aria-label': description });
  for (const language of languages) {
    const segment = h(document, 'span', { class: 'langbar-seg' });
    segment.style.setProperty('--w', `${(language.share * 100).toFixed(2)}%`);
    segment.style.setProperty('--c', language.color);
    bar.append(segment);
  }
  const legend = h(
    document,
    'ul',
    { class: 'langlegend' },
    languages.map((language) => {
      const dot = h(document, 'span', { class: 'dot', 'aria-hidden': 'true' });
      dot.style.setProperty('--c', language.color);
      return h(document, 'li', {}, dot, language.name, ' ', h(document, 'span', { class: 'langlegend-count' }, String(language.count)));
    }),
  );
  container.append(bar, legend);
}

/** Language filter chips ("All" plus one per language) as toggle buttons. */
export function renderLanguageFilters(document, container, languages, active) {
  const chip = (label, value, count) => {
    const button = h(document, 'button', { type: 'button', class: 'chip', 'data-language': value, 'aria-pressed': 'false' }, value ? colorDot(document, value) : null, label, count === undefined ? null : h(document, 'span', { class: 'chip-count' }, String(count)));
    return button;
  };
  container.replaceChildren(chip('All', ''), ...languages.map((language) => chip(language.name, language.name, language.count)));
  setActiveLanguage(container, active);
}

export function setActiveLanguage(container, active) {
  for (const button of container.querySelectorAll('button[data-language]')) {
    const isActive = button.dataset.language.toLowerCase() === active.toLowerCase();
    button.setAttribute('aria-pressed', String(isActive));
  }
}

export function formatResultCount(shown, total) {
  return shown === total ? pluralize(total, 'project') : `${shown} of ${pluralize(total, 'project')}`;
}

export const actionButton = (document, label, action, extraClass = '') =>
  h(document, 'button', { type: 'button', class: `btn btn-small ${extraClass}`.trim(), 'data-action': action }, label);

export const linkButton = (document, label, href, extraClass = '') =>
  h(document, 'a', { class: `btn btn-small ${extraClass}`.trim(), href }, label);

/** Fills a message container (error, empty, notice) and shows it. */
export function showMessage(document, container, { title, detail, actions = [], role }) {
  container.replaceChildren(
    h(document, 'div', { class: 'message-text' }, title ? h(document, 'p', { class: 'message-title' }, title) : null, detail ? h(document, 'p', { class: 'message-detail' }, detail) : null),
    actions.length > 0 ? h(document, 'div', { class: 'message-actions' }, actions) : null,
  );
  if (role) container.setAttribute('role', role);
  else container.removeAttribute('role');
  container.hidden = false;
}

export function hideMessage(container) {
  container.replaceChildren();
  container.hidden = true;
}
