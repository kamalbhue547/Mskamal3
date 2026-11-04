#!/usr/bin/env node
// Refreshes data/repos.snapshot.json from the GitHub API.
//
// The browser fetches live data first; this committed snapshot is the fallback
// shown when GitHub is unreachable or the (unauthenticated) rate limit is hit,
// so the page is never empty.
//
//   npm run snapshot                       refresh (only rewrites the file if repos changed)
//   npm run snapshot -- --force            always rewrite, bumping generatedAt
//   GITHUB_TOKEN=... npm run snapshot      authenticated, for a higher rate limit
//
// The token is only used by this script and is never sent to the browser.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseConfig } from '../assets/js/config.js';
import { fetchRepos } from '../assets/js/github.js';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const SNAPSHOT_PATH = 'data/repos.snapshot.json';

const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' });

/**
 * Fetches the repositories configured in site.config.json and writes the snapshot.
 *
 * @param {{ root?: string, fetch?: typeof fetch, token?: string, now?: () => number, force?: boolean }} [options]
 * @returns {Promise<{ changed: boolean, path: string, username: string, count: number }>}
 */
export async function refreshSnapshot({ root = DEFAULT_ROOT, fetch: doFetch = globalThis.fetch, token, now = Date.now, force = false } = {}) {
  const config = parseConfig(JSON.parse(await readFile(join(root, 'site.config.json'), 'utf8')));

  const authedFetch = token ? (url, init = {}) => doFetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } }) : doFetch;
  const repos = (await fetchRepos(config.username, { fetch: authedFetch })).sort(byName);

  const path = join(root, SNAPSHOT_PATH);
  // Missing, unreadable or corrupt (say, merge-conflict markers) all mean "nothing to compare with", so the file gets rewritten.
  const existing = await readFile(path, 'utf8').then(JSON.parse).catch(() => null);
  const unchanged = existing && JSON.stringify(existing.repos) === JSON.stringify(repos) && existing.username === config.username;
  if (unchanged && !force) return { changed: false, path, username: config.username, count: repos.length };

  const snapshot = { generatedAt: new Date(now()).toISOString(), username: config.username, repos };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  return { changed: true, path, username: config.username, count: repos.length };
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--force');
  if (unknown.length > 0) {
    console.error(`Unknown option: ${unknown[0]}\nUsage: node scripts/snapshot.mjs [--force]`);
    process.exit(2);
  }
  try {
    const result = await refreshSnapshot({ token: process.env.GITHUB_TOKEN || undefined, force: args.includes('--force') });
    console.log(
      result.changed
        ? `Wrote ${SNAPSHOT_PATH}: ${result.count} repositories for ${result.username}.`
        : `${SNAPSHOT_PATH} is already up to date (${result.count} repositories for ${result.username}).`,
    );
  } catch (error) {
    console.error(`Could not refresh the snapshot: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
