// Pure data logic for repositories: validation, normalisation, filtering,
// sorting and summaries. Nothing in here touches the DOM or the network, which
// keeps it trivially testable.
//
// Everything that comes from the GitHub API (or from localStorage, or from the
// bundled snapshot) is treated as untrusted input: strings are type-checked and
// trimmed, numbers are coerced to safe integers and URLs are validated so that
// a `javascript:` homepage can never become a clickable link.

const GITHUB_HOST = 'github.com';
const MAX_URL_LENGTH = 2048;
const MAX_DESCRIPTION_LENGTH = 350;
const MAX_TOPICS = 12;

/**
 * @typedef {Object} Repo
 * @property {string} name         Repository name as on GitHub.
 * @property {string} title        Display title (config override or the name).
 * @property {string} description  Plain text, '' when there is none.
 * @property {string} url          https://github.com/... link to the repository.
 * @property {string} homepage     Safe http(s) URL, or ''.
 * @property {string} language     Primary language, or ''.
 * @property {number} stars
 * @property {number} forks
 * @property {string[]} topics
 * @property {number} pushedAt     Epoch milliseconds, 0 when unknown.
 * @property {boolean} isFork
 * @property {boolean} isArchived
 */

/**
 * Returns a normalised absolute URL string, or '' when `value` is not a safe
 * http(s) URL. Scheme-less values such as "example.com" (which GitHub allows
 * in the homepage field) are treated as https.
 *
 * @param {unknown} value
 * @param {{ hosts?: string[], httpsOnly?: boolean }} [options]
 */
export function safeHttpUrl(value, { hosts, httpsOnly = false } = {}) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return '';
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url;
  try {
    url = new URL(candidate);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' && (httpsOnly || url.protocol !== 'http:')) return '';
  if (url.username || url.password) return '';
  if (hosts && !hosts.includes(url.hostname.toLowerCase())) return '';
  return url.href;
}

function cleanText(value, maxLength) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function safeCount(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseTime(value) {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time > 0 ? time : 0;
}

/** Lower-cases and strips punctuation so "A | B." and "a b" compare equal. */
export function canonicalText(value) {
  return typeof value === 'string' ? value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() : '';
}

/**
 * Keeps only the API fields this site reads. The GitHub API returns ~90 fields
 * per repository; trimming keeps the localStorage cache and the committed
 * snapshot small and their diffs readable. Returns null for non-objects.
 *
 * @param {unknown} raw
 */
export function pickRepoFields(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    name: raw.name,
    html_url: raw.html_url,
    description: raw.description,
    homepage: raw.homepage,
    language: raw.language,
    stargazers_count: raw.stargazers_count,
    forks_count: raw.forks_count,
    topics: raw.topics,
    pushed_at: raw.pushed_at,
    fork: raw.fork,
    archived: raw.archived,
  };
}

/**
 * Converts one raw GitHub API repository object into a {@link Repo}.
 * Returns null when it is unusable (no name, or no valid github.com URL).
 *
 * @param {unknown} raw
 * @returns {Repo | null}
 */
export function normalizeRepo(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = cleanText(raw.name, 100);
  const url = safeHttpUrl(raw.html_url, { hosts: [GITHUB_HOST], httpsOnly: true });
  if (!name || !url) return null;

  const topics = Array.isArray(raw.topics)
    ? raw.topics
        .map((topic) => cleanText(topic, 50).toLowerCase())
        .filter(Boolean)
        .slice(0, MAX_TOPICS)
    : [];

  return {
    name,
    title: name,
    description: cleanText(raw.description, MAX_DESCRIPTION_LENGTH),
    url,
    homepage: safeHttpUrl(raw.homepage),
    language: cleanText(raw.language, 40),
    stars: safeCount(raw.stargazers_count),
    forks: safeCount(raw.forks_count),
    topics,
    pushedAt: parseTime(raw.pushed_at),
    isFork: raw.fork === true,
    isArchived: raw.archived === true,
  };
}

/**
 * Normalises a raw API list and applies the site configuration:
 *  - invalid entries and duplicate names are dropped,
 *  - `hiddenRepos` are removed (case-insensitive),
 *  - descriptions listed in `ignoredDescriptions` are blanked (they are
 *    boilerplate such as a copy of the profile bio),
 *  - `projects[name]` can override the title and description.
 *
 * @param {unknown} rawList
 * @param {{ hiddenRepos?: string[], ignoredDescriptions?: string[],
 *           projects?: Record<string, { title?: string, description?: string }> }} [options]
 * @returns {Repo[]}
 */
export function normalizeRepos(rawList, { hiddenRepos = [], ignoredDescriptions = [], projects = {} } = {}) {
  if (!Array.isArray(rawList)) return [];
  const hidden = new Set(hiddenRepos.map((name) => name.toLowerCase()));
  const ignored = new Set(ignoredDescriptions.map(canonicalText).filter(Boolean));
  const overrides = new Map(Object.entries(projects).map(([name, value]) => [name.toLowerCase(), value]));
  const seen = new Set();
  const repos = [];

  for (const raw of rawList) {
    const repo = normalizeRepo(raw);
    if (!repo) continue;
    const key = repo.name.toLowerCase();
    if (hidden.has(key) || seen.has(key)) continue;
    seen.add(key);

    if (ignored.has(canonicalText(repo.description))) repo.description = '';
    const override = overrides.get(key);
    if (override) {
      repo.title = cleanText(override.title, 100) || repo.title;
      repo.description = cleanText(override.description, MAX_DESCRIPTION_LENGTH) || repo.description;
    }
    repos.push(repo);
  }
  return repos;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Returns a new, sorted array.
 * @param {Repo[]} repos
 * @param {'updated' | 'stars' | 'name'} [mode]
 */
export function sortRepos(repos, mode = 'updated') {
  const byTitle = (a, b) => collator.compare(a.title, b.title);
  const comparators = {
    updated: (a, b) => b.pushedAt - a.pushedAt || byTitle(a, b),
    stars: (a, b) => b.stars - a.stars || b.pushedAt - a.pushedAt || byTitle(a, b),
    name: byTitle,
  };
  return [...repos].sort(comparators[mode] ?? comparators.updated);
}

function searchText(repo) {
  return [repo.title, repo.name, repo.description, repo.language, ...repo.topics].join(' ').toLowerCase();
}

/**
 * @param {Repo[]} repos
 * @param {{ query?: string, language?: string, includeForks?: boolean }} [filters]
 */
export function filterRepos(repos, { query = '', language = '', includeForks = false } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const wanted = language.toLowerCase();
  return repos.filter((repo) => {
    if (!includeForks && repo.isFork) return false;
    if (wanted && repo.language.toLowerCase() !== wanted) return false;
    if (terms.length === 0) return true;
    const text = searchText(repo);
    return terms.every((term) => text.includes(term));
  });
}

// Colours follow GitHub's language palette so they look familiar.
const LANGUAGE_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572a5',
  Go: '#00add8',
  HTML: '#e34c26',
  CSS: '#8b5cf6',
  SCSS: '#c6538c',
  Rust: '#dea584',
  Java: '#b07219',
  Kotlin: '#a97bff',
  Swift: '#f05138',
  C: '#8a8f98',
  'C++': '#f34b7d',
  'C#': '#178600',
  Ruby: '#cc342d',
  PHP: '#7a86b8',
  Shell: '#89e051',
  Dart: '#00b4ab',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  GLSL: '#5686a5',
  Dockerfile: '#2496ed',
  'Jupyter Notebook': '#da5b0b',
};

/** Known languages get their familiar colour; others get a stable derived hue. */
export function languageColor(name) {
  if (Object.hasOwn(LANGUAGE_COLORS, name)) return LANGUAGE_COLORS[name];
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return `hsl(${hash % 360} 62% 58%)`;
}

/**
 * Languages by number of projects, most used first.
 * @param {Repo[]} repos
 * @returns {{ name: string, count: number, share: number, color: string }[]}
 */
export function languageBreakdown(repos) {
  const counts = new Map();
  for (const repo of repos) {
    if (repo.language) counts.set(repo.language, (counts.get(repo.language) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0]))
    .map(([name, count]) => ({ name, count, share: count / total, color: languageColor(name) }));
}

/**
 * Headline numbers for the hero. Forks are excluded: this describes the
 * owner's own work.
 *
 * @param {Repo[]} repos
 */
export function summarize(repos) {
  const own = repos.filter((repo) => !repo.isFork);
  return {
    count: own.length,
    stars: own.reduce((sum, repo) => sum + repo.stars, 0),
    languages: languageBreakdown(own),
    lastPushAt: own.reduce((latest, repo) => Math.max(latest, repo.pushedAt), 0),
  };
}
