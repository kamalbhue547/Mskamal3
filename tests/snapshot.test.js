import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { SNAPSHOT_PATH, refreshSnapshot } from '../scripts/snapshot.mjs';
import { testConfig } from './helpers/app.js';
import { jsonResponse, offlineFetch, stubFetch } from './helpers/fetch.js';
import { OWNER, rawRepo } from './helpers/fixtures.js';

const T1 = Date.UTC(2026, 11 - 1, 4, 6, 0, 0);
const T2 = Date.UTC(2026, 11 - 1, 5, 6, 0, 0);
const SCRIPT = new URL('../scripts/snapshot.mjs', import.meta.url).pathname;

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mskamal3-snapshot-'));
  writeFileSync(join(root, 'site.config.json'), JSON.stringify(testConfig()));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = () => join(root, SNAPSHOT_PATH);
const read = () => JSON.parse(readFileSync(file(), 'utf8'));
const api = (repos) => stubFetch(() => jsonResponse(repos));
const refresh = (options) => refreshSnapshot({ root, now: () => T1, ...options });

describe('refreshSnapshot', () => {
  test('writes a trimmed snapshot, sorted by name regardless of case', async () => {
    const result = await refresh({ fetch: api([rawRepo('beta', { fork: true, archived: true }), rawRepo('Zulu'), rawRepo('alpha')]) });

    assert.deepEqual({ ...result, path: undefined }, { changed: true, path: undefined, username: OWNER, count: 3 });
    assert.equal(result.path, file());
    const snapshot = read();
    assert.equal(snapshot.generatedAt, new Date(T1).toISOString());
    assert.equal(snapshot.username, OWNER);
    assert.deepEqual(snapshot.repos.map((repo) => repo.name), ['alpha', 'beta', 'Zulu'], 'a plain code-unit sort would put "Zulu" first');
    assert.deepEqual(Object.keys(snapshot.repos[0]).sort(), ['archived', 'description', 'fork', 'forks_count', 'homepage', 'html_url', 'language', 'name', 'pushed_at', 'stargazers_count', 'topics']);
    assert.equal(snapshot.repos[1].fork, true, 'forks stay in the snapshot: filtering happens in the UI');
    assert.equal(snapshot.repos[1].archived, true);
    assert.equal(snapshot.repos[0].fork, false);
  });

  test('creates the data directory on first run and writes pretty-printed JSON with a trailing newline', async () => {
    await refresh({ fetch: api([rawRepo('one')]) });
    const text = readFileSync(file(), 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.match(text, /\n {2}"username": "octo"/);
  });

  test('leaves the file untouched when nothing changed, even if GitHub returns a different order', async () => {
    await refresh({ fetch: api([rawRepo('a'), rawRepo('b')]) });
    const before = readFileSync(file(), 'utf8');
    utimesSync(file(), 1_000, 1_000);
    const mtime = statSync(file()).mtimeMs;

    const result = await refresh({ fetch: api([rawRepo('b'), rawRepo('a')]), now: () => T2 });

    assert.equal(result.changed, false);
    assert.equal(result.count, 2);
    assert.equal(readFileSync(file(), 'utf8'), before);
    assert.equal(statSync(file()).mtimeMs, mtime);
  });

  test('rewrites, with a new timestamp, when a repository changed', async () => {
    await refresh({ fetch: api([rawRepo('a', { stargazers_count: 1 })]) });
    const result = await refresh({ fetch: api([rawRepo('a', { stargazers_count: 2 })]), now: () => T2 });
    assert.equal(result.changed, true);
    assert.equal(read().repos[0].stargazers_count, 2);
    assert.equal(read().generatedAt, new Date(T2).toISOString());
  });

  test('rewrites when a repository appears or disappears', async () => {
    await refresh({ fetch: api([rawRepo('a')]) });
    assert.equal((await refresh({ fetch: api([rawRepo('a'), rawRepo('b')]) })).changed, true);
    assert.equal((await refresh({ fetch: api([rawRepo('a')]) })).changed, true);
  });

  test('rewrites when the snapshot belongs to a different account', async () => {
    await refresh({ fetch: api([rawRepo('a')]) });
    writeFileSync(file(), JSON.stringify({ generatedAt: 'x', username: 'someone-else', repos: read().repos }));
    assert.equal((await refresh({ fetch: api([rawRepo('a')]) })).changed, true);
    assert.equal(read().username, OWNER);
  });

  test('"force" rewrites an identical snapshot to bump generatedAt', async () => {
    await refresh({ fetch: api([rawRepo('a')]) });
    const result = await refresh({ fetch: api([rawRepo('a')]), now: () => T2, force: true });
    assert.equal(result.changed, true);
    assert.equal(read().generatedAt, new Date(T2).toISOString());
  });

  test('replaces a corrupt snapshot instead of failing', async () => {
    await refresh({ fetch: api([rawRepo('a')]) });
    writeFileSync(file(), '{ not json');
    assert.equal((await refresh({ fetch: api([rawRepo('a')]) })).changed, true);
    assert.equal(read().repos.length, 1);
  });

  test('follows pagination', async () => {
    const page = (number) => Array.from({ length: number === 1 ? 100 : 1 }, (_, index) => rawRepo(`repo-${number}-${index}`));
    const fetch = stubFetch((url) => jsonResponse(page(Number(new URL(url).searchParams.get('page')))));
    const result = await refresh({ fetch });
    assert.equal(result.count, 101);
    assert.equal(fetch.calls.length, 2);
  });
});

describe('the GitHub token', () => {
  test('is sent as a Bearer header on every request, and never stored or put in a URL', async () => {
    const fetch = api([rawRepo('a')]);
    await refresh({ fetch, token: 'ghp_secret123' });
    assert.ok(fetch.calls.length > 0);
    for (const call of fetch.calls) {
      assert.equal(call.init.headers.Authorization, 'Bearer ghp_secret123');
      assert.ok(!call.url.includes('ghp_secret123'));
    }
    assert.ok(!readFileSync(file(), 'utf8').includes('ghp_secret123'));
  });

  test('is not invented when absent', async () => {
    const fetch = api([rawRepo('a')]);
    await refresh({ fetch });
    for (const call of fetch.calls) assert.equal(call.init.headers?.Authorization, undefined);
  });

  test('only ever travels to api.github.com for the configured user', async () => {
    const fetch = api([rawRepo('a')]);
    await refresh({ fetch, token: 'ghp_secret123' });
    for (const call of fetch.calls) assert.ok(call.url.startsWith(`https://api.github.com/users/${OWNER}/repos?`), call.url);
  });
});

describe('failures', () => {
  test('keep the existing snapshot intact', async () => {
    await refresh({ fetch: api([rawRepo('a')]) });
    const before = readFileSync(file(), 'utf8');

    await assert.rejects(refresh({ fetch: offlineFetch(), now: () => T2 }), { kind: 'network' });
    await assert.rejects(refresh({ fetch: stubFetch(() => jsonResponse({ message: 'rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0' } })) }), { kind: 'rate-limit' });
    await assert.rejects(refresh({ fetch: stubFetch(() => jsonResponse({ nope: true })) }), { kind: 'invalid' });
    assert.equal(readFileSync(file(), 'utf8'), before);
  });

  test('do not leave a half-made snapshot behind on the first run', async () => {
    await assert.rejects(refresh({ fetch: offlineFetch() }));
    assert.equal(existsSync(file()), false);
  });

  test('a missing or invalid site.config.json is reported', async () => {
    rmSync(join(root, 'site.config.json'));
    await assert.rejects(refresh({ fetch: api([]) }));
    writeFileSync(join(root, 'site.config.json'), JSON.stringify({ username: '../etc' }));
    await assert.rejects(refresh({ fetch: api([]) }));
    writeFileSync(join(root, 'site.config.json'), '{ nope');
    await assert.rejects(refresh({ fetch: api([]) }));
  });
});

describe('command line', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 });

  test('rejects unknown options before touching the network', () => {
    const result = run('--bogus');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown option: --bogus/);
    assert.match(result.stderr, /Usage: node scripts\/snapshot\.mjs \[--force\]/);
  });

  test('importing the module does not run it', async () => {
    // If this ran main(), the process would exit or hit the network while the test file loads.
    assert.equal(typeof refreshSnapshot, 'function');
  });
});
