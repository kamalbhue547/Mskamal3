import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE_TTL_MS,
  GitHubError,
  describeError,
  fetchRepos,
  loadRepos,
  loadSnapshot,
  readCache,
  reposUrl,
  writeCache,
} from '../assets/js/github.js';
import { NOW, OWNER, brokenStorage, memoryStorage, rawRepo } from './helpers/fixtures.js';
import { hangingFetch, jsonResponse, offlineFetch, routedFetch, stubFetch } from './helpers/fetch.js';

const SNAPSHOT_URL = './data/repos.snapshot.json';
const snapshotBody = { generatedAt: '2026-11-01T00:00:00Z', username: OWNER, repos: [rawRepo('snap-1'), rawRepo('snap-2')] };
const names = (repos) => repos.map((repo) => repo.name);

async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected the promise to reject');
}

describe('reposUrl', () => {
  test('targets the public repos endpoint with explicit paging', () => {
    const url = new URL(reposUrl('octo-cat', { page: 2, perPage: 50 }));
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/users/octo-cat/repos');
    assert.equal(url.searchParams.get('type'), 'owner');
    assert.equal(url.searchParams.get('sort'), 'pushed');
    assert.equal(url.searchParams.get('per_page'), '50');
    assert.equal(url.searchParams.get('page'), '2');
  });

  test('percent-encodes the username so it cannot alter the path', () => {
    assert.equal(new URL(reposUrl('a/../b?x=1')).pathname, '/users/a%2F..%2Fb%3Fx%3D1/repos');
  });
});

describe('fetchRepos', () => {
  test('returns repositories trimmed to the fields the site uses', async () => {
    const fetch = stubFetch(() => jsonResponse([rawRepo('alpha'), rawRepo('beta')]));
    const repos = await fetchRepos(OWNER, { fetch });
    assert.deepEqual(names(repos), ['alpha', 'beta']);
    assert.equal('node_id' in repos[0], false);
    assert.equal(fetch.calls.length, 1);
    assert.equal(fetch.calls[0].init.headers.Accept, 'application/vnd.github+json');
  });

  test('follows pagination until a short page', async () => {
    const pages = { 1: [rawRepo('a'), rawRepo('b')], 2: [rawRepo('c')] };
    const fetch = stubFetch((url) => jsonResponse(pages[new URL(url).searchParams.get('page')]));
    const repos = await fetchRepos(OWNER, { fetch, perPage: 2 });
    assert.deepEqual(names(repos), ['a', 'b', 'c']);
    assert.equal(fetch.calls.length, 2);
  });

  test('never requests more than maxPages pages', async () => {
    const fetch = stubFetch(() => jsonResponse([rawRepo('x'), rawRepo('y')]));
    const repos = await fetchRepos(OWNER, { fetch, perPage: 2, maxPages: 2 });
    assert.equal(fetch.calls.length, 2);
    assert.equal(repos.length, 4);
  });

  test('skips non-object entries inside the list', async () => {
    const fetch = stubFetch(() => jsonResponse([rawRepo('ok'), null, 'junk', 7]));
    assert.deepEqual(names(await fetchRepos(OWNER, { fetch })), ['ok']);
  });

  test('maps 404 to not-found', async () => {
    const fetch = stubFetch(() => jsonResponse({ message: 'Not Found' }, { status: 404 }));
    const error = await rejection(fetchRepos(OWNER, { fetch }));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.kind, 'not-found');
    assert.equal(error.status, 404);
  });

  test('maps an exhausted 403 to rate-limit and reads the reset time', async () => {
    const resetSeconds = Math.floor(NOW / 1000) + 600;
    const fetch = stubFetch(() =>
      jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetSeconds) } }),
    );
    const error = await rejection(fetchRepos(OWNER, { fetch }));
    assert.equal(error.kind, 'rate-limit');
    assert.equal(error.resetAt, resetSeconds * 1000);
  });

  test('maps 429 to rate-limit even without headers', async () => {
    const error = await rejection(fetchRepos(OWNER, { fetch: stubFetch(() => jsonResponse({}, { status: 429 })) }));
    assert.equal(error.kind, 'rate-limit');
    assert.equal(error.resetAt, 0);
  });

  test('a 403 that is not rate limiting is a plain http error', async () => {
    const fetch = stubFetch(() => jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '41' } }));
    assert.equal((await rejection(fetchRepos(OWNER, { fetch }))).kind, 'http');
  });

  test('maps server errors to http', async () => {
    const error = await rejection(fetchRepos(OWNER, { fetch: stubFetch(() => jsonResponse({}, { status: 503 })) }));
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 503);
  });

  test('rejects malformed bodies as invalid', async () => {
    const notJson = stubFetch(() => jsonResponse('<html>captive portal</html>'));
    assert.equal((await rejection(fetchRepos(OWNER, { fetch: notJson }))).kind, 'invalid');
    const notList = stubFetch(() => jsonResponse({ message: 'surprise' }));
    assert.equal((await rejection(fetchRepos(OWNER, { fetch: notList }))).kind, 'invalid');
  });

  test('reports network failures and keeps the cause', async () => {
    const error = await rejection(fetchRepos(OWNER, { fetch: offlineFetch() }));
    assert.equal(error.kind, 'network');
    assert.ok(error.cause instanceof TypeError);
  });

  test('times out hung requests', async () => {
    const error = await rejection(fetchRepos(OWNER, { fetch: hangingFetch(), timeoutMs: 20 }));
    assert.equal(error.kind, 'timeout');
  });

  test('fails cleanly when fetch is unavailable', async () => {
    const error = await rejection(fetchRepos(OWNER, { fetch: null }));
    assert.equal(error.kind, 'network');
  });
});

describe('loadSnapshot', () => {
  test('returns the repos and the generation time', async () => {
    const snapshot = await loadSnapshot({ fetch: routedFetch({ snapshot: snapshotBody }), url: SNAPSHOT_URL });
    assert.deepEqual(names(snapshot.repos), ['snap-1', 'snap-2']);
    assert.equal(snapshot.fetchedAt, Date.UTC(2026, 10, 1));
  });

  test('tolerates a missing or garbled generatedAt', async () => {
    const fetch = routedFetch({ snapshot: { repos: [rawRepo('a')], generatedAt: 'nope' } });
    assert.equal((await loadSnapshot({ fetch, url: SNAPSHOT_URL })).fetchedAt, 0);
  });

  test('rejects missing files and bad shapes', async () => {
    assert.equal((await rejection(loadSnapshot({ fetch: routedFetch({}), url: SNAPSHOT_URL }))).kind, 'http');
    assert.equal((await rejection(loadSnapshot({ fetch: routedFetch({ snapshot: { nope: 1 } }), url: SNAPSHOT_URL }))).kind, 'invalid');
    assert.equal((await rejection(loadSnapshot({ fetch: routedFetch({ snapshot: null }), url: SNAPSHOT_URL }))).kind, 'invalid');
  });
});

describe('cache', () => {
  test('round-trips repositories', () => {
    const storage = memoryStorage();
    writeCache(storage, 'Octo', [rawRepo('a')], NOW);
    const cached = readCache(storage, 'octo', NOW + 1000);
    assert.equal(cached.fetchedAt, NOW);
    assert.deepEqual(names(cached.repos), ['a']);
  });

  test('is keyed per user, case-insensitively', () => {
    const storage = memoryStorage();
    writeCache(storage, 'octo', [rawRepo('a')], NOW);
    assert.equal(readCache(storage, 'someone-else', NOW), null);
    assert.ok(readCache(storage, 'OCTO', NOW));
  });

  test('ignores corrupted, wrong-version, future-dated and oversized entries', () => {
    const key = 'mskamal3:repos:v1:octo';
    const read = (value) => readCache(memoryStorage({ [key]: value }), 'octo', NOW);
    assert.equal(read('{not json'), null);
    assert.equal(read('null'), null);
    assert.equal(read(JSON.stringify({ version: 0, fetchedAt: NOW - 1, repos: [] })), null);
    assert.equal(read(JSON.stringify({ version: 1, fetchedAt: 'yesterday', repos: [] })), null);
    assert.equal(read(JSON.stringify({ version: 1, fetchedAt: NOW - 1, repos: 'x' })), null);
    assert.equal(read(JSON.stringify({ version: 1, fetchedAt: NOW + 3_600_000, repos: [] })), null);
    assert.equal(read(JSON.stringify({ version: 1, fetchedAt: NOW - 1, repos: new Array(501).fill({}) })), null);
    assert.ok(read(JSON.stringify({ version: 1, fetchedAt: NOW - 1, repos: [] })));
  });

  test('never throws when storage is missing or broken', () => {
    assert.equal(readCache(undefined, 'octo', NOW), null);
    assert.equal(readCache(brokenStorage(), 'octo', NOW), null);
    assert.doesNotThrow(() => writeCache(undefined, 'octo', [], NOW));
    assert.doesNotThrow(() => writeCache(brokenStorage(), 'octo', [], NOW));
  });
});

describe('loadRepos fallback chain', () => {
  const base = { username: OWNER, snapshotUrl: SNAPSHOT_URL, now: () => NOW };
  const liveOk = () => routedFetch({ '/users/': [rawRepo('live-1')], snapshot: snapshotBody });

  test('live data is used and cached', async () => {
    const storage = memoryStorage();
    const result = await loadRepos({ ...base, fetch: liveOk(), storage });
    assert.equal(result.source, 'live');
    assert.equal(result.fetchedAt, NOW);
    assert.equal(result.error, null);
    assert.deepEqual(names(result.repos), ['live-1']);
    assert.ok(readCache(storage, OWNER, NOW));
  });

  test('a fresh cache is served without touching the network', async () => {
    const storage = memoryStorage();
    writeCache(storage, OWNER, [rawRepo('cached')], NOW - 60_000);
    const fetch = liveOk();
    const result = await loadRepos({ ...base, fetch, storage });
    assert.equal(result.source, 'cache');
    assert.equal(result.fetchedAt, NOW - 60_000);
    assert.deepEqual(names(result.repos), ['cached']);
    assert.equal(fetch.calls.length, 0);
  });

  test('force bypasses a fresh cache', async () => {
    const storage = memoryStorage();
    writeCache(storage, OWNER, [rawRepo('cached')], NOW - 60_000);
    const result = await loadRepos({ ...base, fetch: liveOk(), storage, force: true });
    assert.equal(result.source, 'live');
    assert.deepEqual(names(result.repos), ['live-1']);
  });

  test('an expired cache triggers a refresh', async () => {
    const storage = memoryStorage();
    writeCache(storage, OWNER, [rawRepo('cached')], NOW - CACHE_TTL_MS - 1);
    assert.equal((await loadRepos({ ...base, fetch: liveOk(), storage })).source, 'live');
  });

  test('network failure falls back to a stale cache, reporting why', async () => {
    const storage = memoryStorage();
    writeCache(storage, OWNER, [rawRepo('stale')], NOW - CACHE_TTL_MS - 5000);
    const result = await loadRepos({ ...base, fetch: offlineFetch(), storage });
    assert.equal(result.source, 'stale-cache');
    assert.deepEqual(names(result.repos), ['stale']);
    assert.equal(result.error.kind, 'network');
  });

  test('without any cache the committed snapshot is used', async () => {
    const result = await loadRepos({ ...base, fetch: routedFetch({ '/users/': jsonResponse({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } }), snapshot: snapshotBody }), storage: memoryStorage() });
    assert.equal(result.source, 'snapshot');
    assert.deepEqual(names(result.repos), ['snap-1', 'snap-2']);
    assert.equal(result.fetchedAt, Date.UTC(2026, 10, 1));
    assert.equal(result.error.kind, 'rate-limit');
  });

  test('works with no storage at all', async () => {
    const result = await loadRepos({ ...base, fetch: liveOk(), storage: undefined });
    assert.equal(result.source, 'live');
  });

  test('works when storage throws on every call', async () => {
    const result = await loadRepos({ ...base, fetch: liveOk(), storage: brokenStorage() });
    assert.equal(result.source, 'live');
  });

  test('rejects with the original live error when every source fails', async () => {
    const error = await rejection(loadRepos({ ...base, fetch: routedFetch({ '/users/': jsonResponse({}, { status: 500 }) }), storage: memoryStorage() }));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.kind, 'http');
    assert.equal(error.status, 500);
  });

  test('rejects when there is no snapshot configured either', async () => {
    const error = await rejection(loadRepos({ username: OWNER, now: () => NOW, fetch: offlineFetch(), storage: memoryStorage() }));
    assert.equal(error.kind, 'network');
  });

  test('wraps unexpected exceptions in a GitHubError', async () => {
    const fetch = async () => {
      throw new RangeError('boom');
    };
    const error = await rejection(loadRepos({ username: OWNER, now: () => NOW, fetch, storage: memoryStorage() }));
    assert.ok(error instanceof GitHubError);
    assert.equal(error.kind, 'network');
    assert.ok(error.cause instanceof RangeError);
  });
});

describe('describeError', () => {
  test('gives a distinct, human message per kind', () => {
    const kinds = ['network', 'timeout', 'not-found', 'http', 'invalid'].map((kind) => describeError(new GitHubError('x', { kind }), NOW));
    assert.equal(new Set(kinds.slice(0, 3)).size, 3);
    assert.equal(kinds[3], kinds[4]);
    assert.match(kinds[0], /couldn't be reached/i);
    assert.match(kinds[1], /too long/i);
    assert.match(kinds[2], /couldn't be found/i);
  });

  test('explains when a rate limit resets, with correct pluralisation', () => {
    const limited = (resetAt) => describeError(new GitHubError('x', { kind: 'rate-limit', resetAt }), NOW);
    assert.match(limited(NOW + 30_000), /resets in about 1 minute\./);
    assert.match(limited(NOW + 12 * 60_000), /resets in about 12 minutes\./);
    assert.equal(limited(0), "GitHub's API rate limit was reached.");
  });

  test('handles non-GitHub errors and undefined', () => {
    assert.match(describeError(new Error('?'), NOW), /unexpected/i);
    assert.match(describeError(undefined, NOW), /unexpected/i);
  });
});
