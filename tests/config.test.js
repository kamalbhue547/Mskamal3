import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, parseConfig } from '../assets/js/config.js';
import { jsonResponse, offlineFetch, stubFetch } from './helpers/fetch.js';

describe('parseConfig', () => {
  test('applies defaults to a minimal config', () => {
    assert.deepEqual(parseConfig({ username: 'octo' }), {
      username: 'octo',
      hiddenRepos: [],
      ignoredDescriptions: [],
      projects: {},
      backdrop: true,
    });
  });

  test('keeps valid optional settings and trims strings', () => {
    const config = parseConfig({
      username: ' octo-cat ',
      hiddenRepos: [' profile ', ''],
      ignoredDescriptions: ['bio'],
      projects: { alpha: { title: 'Alpha', description: 'First' }, beta: {} },
      backdrop: false,
    });
    assert.equal(config.username, 'octo-cat');
    assert.deepEqual(config.hiddenRepos, ['profile']);
    assert.deepEqual(config.ignoredDescriptions, ['bio']);
    assert.deepEqual(config.projects.alpha, { title: 'Alpha', description: 'First' });
    assert.deepEqual(config.projects.beta, { title: undefined, description: undefined });
    assert.equal(config.backdrop, false);
  });

  test('accepts the shapes GitHub allows for usernames', () => {
    for (const name of ['a', 'octo', 'octo-cat', 'Octo1', '1octo', 'a'.repeat(39)]) {
      assert.equal(parseConfig({ username: name }).username, name, name);
    }
  });

  test('rejects usernames GitHub would not allow', () => {
    for (const bad of [undefined, null, 42, '', ' ', '-octo', 'octo-', 'oc--to', 'oc to', 'octo/cat', 'octo?x=1', 'a'.repeat(40), 'ünï']) {
      assert.throws(() => parseConfig({ username: bad }), /username/, String(bad));
    }
  });

  test('rejects non-object roots', () => {
    for (const bad of [null, undefined, 'x', 5, [], true]) {
      assert.throws(() => parseConfig(bad), /JSON object/, String(bad));
    }
  });

  test('rejects wrongly typed optional fields with a helpful message', () => {
    assert.throws(() => parseConfig({ username: 'a', hiddenRepos: 'x' }), /"hiddenRepos" must be a list of strings/);
    assert.throws(() => parseConfig({ username: 'a', hiddenRepos: [1] }), /"hiddenRepos"/);
    assert.throws(() => parseConfig({ username: 'a', ignoredDescriptions: {} }), /"ignoredDescriptions"/);
    assert.throws(() => parseConfig({ username: 'a', projects: [] }), /"projects" must be an object/);
    assert.throws(() => parseConfig({ username: 'a', projects: { x: 'nope' } }), /"projects.x" must be an object/);
    assert.throws(() => parseConfig({ username: 'a', projects: { x: { title: 5 } } }), /"projects.x.title" must be a string/);
    assert.throws(() => parseConfig({ username: 'a', projects: { x: { description: [] } } }), /"projects.x.description" must be a string/);
    assert.throws(() => parseConfig({ username: 'a', backdrop: 'no' }), /"backdrop" must be true or false/);
  });
});

describe('loadConfig', () => {
  test('fetches and validates', async () => {
    const fetch = stubFetch(() => jsonResponse({ username: 'octo' }));
    const config = await loadConfig({ fetch, url: './site.config.json' });
    assert.equal(config.username, 'octo');
    assert.equal(fetch.calls[0].url, './site.config.json');
  });

  test('explains HTTP failures, network failures and invalid JSON', async () => {
    await assert.rejects(loadConfig({ fetch: stubFetch(() => jsonResponse({}, { status: 404 })), url: 'x' }), /HTTP 404/);
    await assert.rejects(loadConfig({ fetch: offlineFetch(), url: 'x' }), /Could not load site\.config\.json/);
    await assert.rejects(loadConfig({ fetch: stubFetch(() => jsonResponse('{oops')), url: 'x' }), /not valid JSON/);
  });

  test('surfaces validation errors from the file contents', async () => {
    await assert.rejects(loadConfig({ fetch: stubFetch(() => jsonResponse({ username: '-bad-' })), url: 'x' }), /username/);
  });
});
