// Guards the files you edit by hand (site.config.json) or refresh by script
// (data/repos.snapshot.json) against typos and drift, and boots the real page
// from them end to end.

import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parseConfig } from '../assets/js/config.js';
import { normalizeRepo, normalizeRepos } from '../assets/js/repos.js';
import { bootApp, offline, siteFetch } from './helpers/app.js';

const path = (relative) => new URL(`../${relative}`, import.meta.url);
const readJson = (relative) => JSON.parse(readFileSync(path(relative), 'utf8'));

const rawConfig = readJson('site.config.json');
const config = parseConfig(rawConfig);
const snapshot = readJson('data/repos.snapshot.json');
const names = new Set(snapshot.repos.map((repo) => repo.name.toLowerCase()));

describe('site.config.json', () => {
  test('is accepted by the same parser the page uses, and nothing you wrote is silently dropped', () => {
    for (const key of Object.keys(rawConfig)) assert.ok(key in config, `"${key}" is not a recognised setting`);
    assert.deepEqual(config.projects, rawConfig.projects, 'a misspelt field inside "projects" would vanish');
    assert.deepEqual(config.hiddenRepos, rawConfig.hiddenRepos);
    assert.deepEqual(config.ignoredDescriptions, rawConfig.ignoredDescriptions);
  });

  test('every hidden repository and every project override names a repository that exists', () => {
    for (const name of config.hiddenRepos) assert.ok(names.has(name.toLowerCase()), `hiddenRepos: "${name}" is not in the snapshot`);
    for (const name of Object.keys(config.projects)) assert.ok(names.has(name.toLowerCase()), `projects: "${name}" is not in the snapshot`);
  });

  test('project titles and descriptions are short, plain text', () => {
    for (const [name, project] of Object.entries(config.projects)) {
      assert.ok(project.title && project.title.length <= 40, `${name}: title should be 1-40 characters`);
      assert.ok(project.description.length >= 40 && project.description.length <= 300, `${name}: description should be 40-300 characters (is ${project.description.length})`);
      for (const text of [project.title, project.description]) assert.doesNotMatch(text, /[<>]/, `${name}: markup is not rendered`);
    }
  });

  test('the repositories shown by default all have a handwritten title and description', () => {
    const shown = normalizeRepos(snapshot.repos, config).filter((repo) => !repo.isFork);
    assert.ok(shown.length > 0);
    for (const repo of shown) assert.ok(config.projects[repo.name], `${repo.name} has no entry in "projects"; its card falls back to the GitHub description`);
  });
});

describe('data/repos.snapshot.json', () => {
  test('has the shape the page and the refresh script agree on', () => {
    assert.deepEqual(Object.keys(snapshot), ['generatedAt', 'username', 'repos']);
    assert.ok(Array.isArray(snapshot.repos) && snapshot.repos.length > 0);
  });

  test('belongs to the configured account', () => {
    assert.equal(snapshot.username, config.username);
    for (const repo of snapshot.repos) assert.ok(repo.html_url.startsWith(`https://github.com/${config.username}/`), repo.html_url);
  });

  test('carries a valid, non-future timestamp', () => {
    assert.equal(new Date(snapshot.generatedAt).toISOString(), snapshot.generatedAt);
    assert.ok(Date.parse(snapshot.generatedAt) <= Date.now() + 24 * 60 * 60 * 1000, 'generatedAt is in the future');
  });

  test('every repository passes the page\'s own validation, with unique names, sorted like the script writes them', () => {
    assert.ok(snapshot.repos.every((repo) => normalizeRepo(repo) !== null));
    const lower = snapshot.repos.map((repo) => repo.name.toLowerCase());
    assert.equal(new Set(lower).size, lower.length);
    const sorted = [...snapshot.repos].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    assert.deepEqual(snapshot.repos.map((repo) => repo.name), sorted.map((repo) => repo.name));
  });

  test('is formatted exactly as `npm run snapshot` writes it, so refreshes make clean diffs', () => {
    assert.equal(readFileSync(path('data/repos.snapshot.json'), 'utf8'), `${JSON.stringify(snapshot, null, 2)}\n`);
  });

  test('is small and contains no credentials', () => {
    const text = readFileSync(path('data/repos.snapshot.json'), 'utf8');
    assert.ok(statSync(path('data/repos.snapshot.json')).size < 200 * 1024);
    assert.doesNotMatch(text, /ghp_|gho_|github_pat_|Bearer |Authorization/i);
  });
});

describe('the shipped page, booted from the real files with GitHub unreachable', () => {
  const boot = () => bootApp({ fetch: siteFetch({ config: rawConfig, snapshot, api: offline }), now: Date.parse(snapshot.generatedAt) + 60_000 });

  test('shows every configured project, with the handwritten titles', async () => {
    const page = await boot();
    const expected = normalizeRepos(snapshot.repos, config).filter((repo) => !repo.isFork).map((repo) => repo.title);
    assert.ok(expected.length >= 1);
    assert.deepEqual([...page.titles()].sort(), [...expected].sort());
    for (const project of Object.values(config.projects)) assert.ok(page.titles().includes(project.title), `${project.title} is missing from the page`);
  });

  test('hides the profile repositories and never repeats the shared tagline on a card', async () => {
    const page = await boot();
    for (const name of config.hiddenRepos) assert.ok(!page.titles().some((title) => title.toLowerCase() === name.toLowerCase()), `${name} should be hidden`);
    const cardText = page.$$('#grid article.card').map((card) => card.textContent).join('\n');
    for (const tagline of config.ignoredDescriptions) assert.ok(!cardText.includes(tagline), 'the profile tagline must not be repeated on project cards');
    assert.doesNotMatch(cardText, /No description yet/);
  });

  test('tells the visitor it is showing a saved copy, and offers a retry', async () => {
    const page = await boot();
    assert.match(page.text('#notice'), /saved copy|snapshot|couldn.t reach|can.t reach/i);
    assert.ok(page.$('#notice [data-action="retry"]'));
  });

  test('every card links to a repository of the configured account', async () => {
    const page = await boot();
    const links = page.$$('#grid article.card a[href^="https://github.com/"]').map((a) => a.getAttribute('href'));
    assert.ok(links.length >= 1);
    for (const href of links) assert.ok(href.startsWith(`https://github.com/${config.username}/`), href);
  });
});
