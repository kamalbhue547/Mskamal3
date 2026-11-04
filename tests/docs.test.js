// Keeps README.md honest: what it says about scripts, files, settings and
// numbers is checked against the real code, so the docs cannot silently rot.

import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, test } from 'node:test';
import { parseConfig } from '../assets/js/config.js';
import { CACHE_TTL_MS, DEFAULT_TIMEOUT_MS, fetchRepos } from '../assets/js/github.js';
import { parseArgs } from '../scripts/serve.mjs';
import { jsonResponse, stubFetch } from './helpers/fetch.js';
import { OWNER, rawRepo } from './helpers/fixtures.js';

const root = new URL('../', import.meta.url);
const readme = readFileSync(new URL('README.md', root), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const siteConfig = JSON.parse(readFileSync(new URL('site.config.json', root), 'utf8'));

const codeBlocks = [...readme.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
const inlineCode = [...readme.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
const prose = readme.replace(/```[\s\S]*?```/g, '');

describe('README.md', () => {
  test('starts with the profile tagline, which is also the tagline the site shows', () => {
    const lines = readme.split('\n');
    assert.equal(lines[0], '# Mskamal3');
    assert.equal(lines[2], siteConfig.ignoredDescriptions[0]);
  });

  test('only mentions npm scripts that exist', () => {
    const commands = [...codeBlocks, ...inlineCode].flatMap((text) => [...text.matchAll(/\bnpm (?:run )?([a-z][\w:-]*)/g)].map((match) => match[1]));
    const names = new Set(commands.filter((name) => !['ci', 'install'].includes(name)));
    assert.ok(names.size >= 4, `expected several scripts to be documented, found ${[...names]}`);
    for (const name of names) assert.ok(pkg.scripts[name], `README mentions "npm ${name}", but package.json has no such script`);
  });

  test('every relative link and image points at a file that exists', () => {
    const targets = [...readme.matchAll(/\]\(([^)\s]+)\)/g), ...readme.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
    const local = targets.filter((target) => !/^([a-z][a-z0-9+.-]*:|#)/i.test(target)).map((target) => target.split('#')[0]);
    assert.ok(local.length >= 5, `expected several local references, found ${local}`);
    for (const target of local) assert.ok(existsSync(new URL(target, root)), `README links to ${target}, which does not exist`);
  });

  test('every screenshot has alt text and is small enough not to bloat the repository', () => {
    const images = [...readme.matchAll(/<img\b[^>]*>/g)].map((match) => match[0]);
    assert.ok(images.length >= 2);
    for (const tag of images) {
      assert.match(tag, /\balt="[^"]{20,}"/, `needs descriptive alt text: ${tag}`);
      const source = tag.match(/\bsrc="([^"]+)"/)[1];
      assert.ok(statSync(new URL(source, root)).size < 400 * 1024, `${source} is larger than 400 KB`);
    }
  });

  test('documents every setting that site.config.json accepts', () => {
    for (const key of Object.keys(parseConfig({ username: OWNER }))) {
      assert.ok(readme.includes(`| \`${key}\``), `the configuration table does not describe "${key}"`);
    }
  });

  test('every file or folder in the project layout exists', () => {
    const layout = codeBlocks.find((block) => block.startsWith('index.html'));
    assert.ok(layout, 'the project layout block is missing');
    const entries = layout.split('\n').filter((line) => line && !/^\s/.test(line)).map((line) => line.split(/\s{2,}/)[0]);
    assert.ok(entries.length >= 8);
    for (const entry of entries) assert.ok(existsSync(new URL(entry, root)), `the layout lists ${entry}, which does not exist`);
  });

  test('states the Node.js version that package.json requires', () => {
    const minimum = pkg.engines.node.match(/\^(\d+\.\d+)/)[1];
    assert.ok(prose.includes(`Node.js\`) ${minimum}`) || prose.includes(`${minimum} or newer`), `README should say Node.js ${minimum} or newer`);
  });

  test('CI runs the Node versions the README promises, and exactly the documented checks', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
    for (const version of ['22', '24']) assert.match(prose, new RegExp(`\\b${version}\\b`));
    assert.match(workflow, /node:\s*\[22,\s*24\]/);
    assert.match(workflow, /run: npm run lint/);
    assert.match(workflow, /run: npm test/);
  });
});

describe('numbers quoted in the README', () => {
  test('the dev server defaults match what is documented', () => {
    const defaults = parseArgs([], {});
    assert.ok(readme.includes(`http://localhost:${defaults.port}`));
    assert.ok(prose.includes(`\`${defaults.host}\``));
  });

  test('"10 minutes" is the cache lifetime and "10 second" the request timeout', () => {
    assert.equal(CACHE_TTL_MS, 10 * 60 * 1000);
    assert.match(prose, /last 10 minutes/);
    assert.equal(DEFAULT_TIMEOUT_MS, 10_000);
    assert.match(prose, /10 second timeout/);
  });

  test('"up to 300 repositories" is how many the loader really fetches', async () => {
    const fetch = stubFetch(() => jsonResponse(Array.from({ length: 100 }, (_, index) => rawRepo(`repo-${index}`))));
    const repos = await fetchRepos(OWNER, { fetch });
    assert.equal(repos.length, 300);
    assert.equal(fetch.calls.length, 3);
    assert.match(prose, /up to 300 repositories/);
  });
});
