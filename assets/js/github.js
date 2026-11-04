// GitHub data access: a tiny REST client plus a resilient loading strategy.
//
//   fresh cache  ->  live API  ->  stale cache  ->  bundled snapshot  ->  error
//
// The unauthenticated GitHub API allows 60 requests per hour per IP, so the
// result is cached in localStorage for a few minutes, and the committed
// snapshot guarantees the page is never empty when GitHub is unreachable or
// the rate limit has been hit.

import { minutesUntil } from './format.js';
import { pickRepoFields } from './repos.js';

export const API_ROOT = 'https://api.github.com';
export const CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 10_000;
const CACHE_VERSION = 1;
const MAX_CACHED_REPOS = 500;

/**
 * @typedef {'network' | 'timeout' | 'rate-limit' | 'not-found' | 'http' | 'invalid'} GitHubErrorKind
 */

export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{ kind: GitHubErrorKind, status?: number, resetAt?: number, cause?: unknown }} details
   */
  constructor(message, { kind, status = 0, resetAt = 0, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
    /** Epoch milliseconds when the rate limit resets (rate-limit errors only). */
    this.resetAt = resetAt;
  }
}

/** URL of one page of a user's public repositories, most recently pushed first. */
export function reposUrl(username, { page = 1, perPage = 100 } = {}) {
  const url = new URL(`${API_ROOT}/users/${encodeURIComponent(username)}/repos`);
  url.searchParams.set('type', 'owner');
  url.searchParams.set('sort', 'pushed');
  url.searchParams.set('per_page', String(perPage));
  url.searchParams.set('page', String(page));
  return url.toString();
}

/**
 * Runs `task(signal)` and aborts it after `timeoutMs`. Covers both waiting for
 * headers and reading the body.
 */
async function withTimeout(timeoutMs, task) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } catch (cause) {
    if (cause instanceof GitHubError) throw cause;
    throw new GitHubError(controller.signal.aborted ? 'Request timed out' : 'Network error', {
      kind: controller.signal.aborted ? 'timeout' : 'network',
      cause,
    });
  } finally {
    clearTimeout(timer);
  }
}

function errorFromResponse(response) {
  const { status, headers } = response;
  const remaining = headers.get('x-ratelimit-remaining');
  const resetSeconds = Number(headers.get('x-ratelimit-reset'));
  const limited = status === 429 || (status === 403 && (remaining === '0' || headers.has('retry-after')));
  if (limited) {
    return new GitHubError('GitHub API rate limit reached', {
      kind: 'rate-limit',
      status,
      resetAt: Number.isFinite(resetSeconds) && resetSeconds > 0 ? resetSeconds * 1000 : 0,
    });
  }
  if (status === 404) return new GitHubError('GitHub user not found', { kind: 'not-found', status });
  return new GitHubError(`GitHub responded with HTTP ${status}`, { kind: 'http', status });
}

async function readJson(response, what) {
  try {
    return await response.json();
  } catch (cause) {
    throw new GitHubError(`${what} was not valid JSON`, { kind: 'invalid', status: response.status, cause });
  }
}

/**
 * Fetches all public repositories of `username` (up to `maxPages` pages) and
 * returns them trimmed to the fields this site uses.
 *
 * @param {string} username
 * @param {{ fetch?: typeof fetch, perPage?: number, maxPages?: number, timeoutMs?: number }} [options]
 * @returns {Promise<object[]>}
 */
export async function fetchRepos(
  username,
  { fetch: doFetch = globalThis.fetch?.bind(globalThis), perPage = 100, maxPages = 3, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (typeof doFetch !== 'function') {
    throw new GitHubError('fetch is not available in this environment', { kind: 'network' });
  }
  const repos = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const batch = await withTimeout(timeoutMs, async (signal) => {
      const response = await doFetch(reposUrl(username, { page, perPage }), {
        headers: { Accept: 'application/vnd.github+json' },
        signal,
      });
      if (!response.ok) throw errorFromResponse(response);
      const data = await readJson(response, 'GitHub response');
      if (!Array.isArray(data)) {
        throw new GitHubError('GitHub response was not a list of repositories', { kind: 'invalid' });
      }
      return data;
    });
    repos.push(...batch.map(pickRepoFields).filter(Boolean));
    if (batch.length < perPage) break;
  }
  return repos;
}

/** Fetches the committed snapshot: `{ generatedAt, repos }`. */
export async function loadSnapshot({ fetch: doFetch, url, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return withTimeout(timeoutMs, async (signal) => {
    const response = await doFetch(url, { headers: { Accept: 'application/json' }, signal });
    if (!response.ok) throw new GitHubError(`Snapshot responded with HTTP ${response.status}`, { kind: 'http', status: response.status });
    const data = await readJson(response, 'Snapshot');
    if (!data || !Array.isArray(data.repos)) {
      throw new GitHubError('Snapshot has no repository list', { kind: 'invalid' });
    }
    const generatedAt = Date.parse(data.generatedAt);
    return { repos: data.repos, fetchedAt: Number.isFinite(generatedAt) ? generatedAt : 0 };
  });
}

const cacheKey = (username) => `mskamal3:repos:v${CACHE_VERSION}:${username.toLowerCase()}`;

/** Reads the cached repository list; returns null for anything missing or malformed. */
export function readCache(storage, username, now = Date.now()) {
  try {
    const entry = JSON.parse(storage?.getItem(cacheKey(username)) ?? 'null');
    const valid =
      entry &&
      entry.version === CACHE_VERSION &&
      Number.isFinite(entry.fetchedAt) &&
      entry.fetchedAt > 0 &&
      entry.fetchedAt <= now + 60_000 && // tolerate a minute of clock skew, reject timestamps from the future
      Array.isArray(entry.repos) &&
      entry.repos.length <= MAX_CACHED_REPOS;
    return valid ? { fetchedAt: entry.fetchedAt, repos: entry.repos } : null;
  } catch {
    return null; // storage unavailable or JSON corrupted
  }
}

export function writeCache(storage, username, repos, fetchedAt) {
  try {
    storage?.setItem(cacheKey(username), JSON.stringify({ version: CACHE_VERSION, fetchedAt, repos }));
  } catch {
    /* storage unavailable or full: the cache is an optimisation only */
  }
}

/**
 * @typedef {Object} LoadResult
 * @property {object[]} repos        Raw (trimmed) repositories, not yet normalised.
 * @property {'live' | 'cache' | 'stale-cache' | 'snapshot'} source
 * @property {number} fetchedAt      Epoch ms the data was fetched/generated (0 if unknown).
 * @property {GitHubError | null} error  Why live data was unavailable, for fallback sources.
 */

/**
 * Loads repositories using the fallback chain described at the top of the file.
 * Rejects with a {@link GitHubError} only when there is no data from any source.
 *
 * @returns {Promise<LoadResult>}
 */
export async function loadRepos({
  username,
  fetch: doFetch = globalThis.fetch?.bind(globalThis),
  storage,
  now = Date.now,
  snapshotUrl,
  force = false,
  ttlMs = CACHE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const cached = readCache(storage, username, now());
  if (!force && cached && now() - cached.fetchedAt < ttlMs) {
    return { repos: cached.repos, source: 'cache', fetchedAt: cached.fetchedAt, error: null };
  }

  try {
    const repos = await fetchRepos(username, { fetch: doFetch, timeoutMs });
    const fetchedAt = now();
    writeCache(storage, username, repos, fetchedAt);
    return { repos, source: 'live', fetchedAt, error: null };
  } catch (cause) {
    const error = cause instanceof GitHubError ? cause : new GitHubError('Unexpected error', { kind: 'network', cause });
    if (cached) return { repos: cached.repos, source: 'stale-cache', fetchedAt: cached.fetchedAt, error };
    if (snapshotUrl) {
      try {
        const snapshot = await loadSnapshot({ fetch: doFetch, url: snapshotUrl, timeoutMs });
        return { repos: snapshot.repos, source: 'snapshot', fetchedAt: snapshot.fetchedAt, error };
      } catch {
        /* no snapshot either: report the original (live) failure below */
      }
    }
    throw error;
  }
}

/** A short, human-readable reason for a failure, suitable for the UI. */
export function describeError(error, now = Date.now()) {
  switch (error?.kind) {
    case 'rate-limit': {
      const minutes = minutesUntil(error.resetAt, now);
      return minutes > 0
        ? `GitHub's API rate limit was reached; it resets in about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
        : "GitHub's API rate limit was reached.";
    }
    case 'not-found':
      return "That GitHub user couldn't be found.";
    case 'timeout':
      return 'GitHub took too long to respond.';
    case 'network':
      return "GitHub couldn't be reached. Check your connection.";
    default:
      return 'GitHub returned an unexpected response.';
  }
}
