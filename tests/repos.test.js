import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalText,
  filterRepos,
  languageBreakdown,
  languageColor,
  normalizeRepo,
  normalizeRepos,
  pickRepoFields,
  safeHttpUrl,
  sortRepos,
  summarize,
} from '../assets/js/repos.js';
import { rawRepo } from './helpers/fixtures.js';

describe('safeHttpUrl', () => {
  test('accepts http(s) URLs and normalises them', () => {
    assert.equal(safeHttpUrl('https://example.com'), 'https://example.com/');
    assert.equal(safeHttpUrl('  http://example.com/a?b=1  '), 'http://example.com/a?b=1');
  });

  test('treats scheme-less values (allowed by GitHub) as https', () => {
    assert.equal(safeHttpUrl('example.com/portfolio'), 'https://example.com/portfolio');
  });

  test('rejects every non-http(s) scheme, including script-capable ones', () => {
    for (const evil of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://example.com',
      'mailto:a@b.c',
    ]) {
      assert.equal(safeHttpUrl(evil), '', evil);
    }
  });

  test('rejects credentials, junk, non-strings and oversized input', () => {
    assert.equal(safeHttpUrl('https://user:pass@example.com'), '');
    assert.equal(safeHttpUrl('https://exa mple.com'), '');
    assert.equal(safeHttpUrl(''), '');
    assert.equal(safeHttpUrl('   '), '');
    for (const notString of [null, undefined, 42, {}, [], true]) assert.equal(safeHttpUrl(notString), '');
    assert.equal(safeHttpUrl(`https://example.com/${'a'.repeat(3000)}`), '');
  });

  test('can require https and restrict hosts', () => {
    assert.equal(safeHttpUrl('http://github.com/a/b', { httpsOnly: true }), '');
    assert.equal(safeHttpUrl('https://github.com/a/b', { hosts: ['github.com'], httpsOnly: true }), 'https://github.com/a/b');
    assert.equal(safeHttpUrl('https://evil.example/a/b', { hosts: ['github.com'] }), '');
    assert.equal(safeHttpUrl('https://github.com.evil.example/a/b', { hosts: ['github.com'] }), '');
    assert.equal(safeHttpUrl('https://GITHUB.com/a/b', { hosts: ['github.com'] }), 'https://github.com/a/b');
  });
});

describe('pickRepoFields', () => {
  test('keeps only the fields the site reads', () => {
    const picked = pickRepoFields(rawRepo('alpha', { stargazers_count: 3 }));
    assert.deepEqual(Object.keys(picked).sort(), [
      'archived',
      'description',
      'fork',
      'forks_count',
      'homepage',
      'html_url',
      'language',
      'name',
      'pushed_at',
      'stargazers_count',
      'topics',
    ]);
    assert.equal(picked.stargazers_count, 3);
    assert.equal('owner' in picked, false);
    assert.equal('node_id' in picked, false);
  });

  test('returns null for non-objects', () => {
    for (const bad of [null, undefined, 'x', 5]) assert.equal(pickRepoFields(bad), null);
  });
});

describe('normalizeRepo', () => {
  test('maps a full API object', () => {
    const repo = normalizeRepo(
      rawRepo('Alpha', {
        description: '  A   spaced\n out   description ',
        homepage: 'alpha.dev',
        language: 'Go',
        stargazers_count: 12,
        forks_count: 3,
        topics: ['Go', 'CLI'],
        pushed_at: '2026-10-29T07:53:34Z',
        archived: true,
      }),
    );
    assert.deepEqual(repo, {
      name: 'Alpha',
      title: 'Alpha',
      description: 'A spaced out description',
      url: 'https://github.com/octo/Alpha',
      homepage: 'https://alpha.dev/',
      language: 'Go',
      stars: 12,
      forks: 3,
      topics: ['go', 'cli'],
      pushedAt: Date.UTC(2026, 9, 29, 7, 53, 34),
      isFork: false,
      isArchived: true,
    });
  });

  test('fills safe defaults for null/missing optional fields', () => {
    const repo = normalizeRepo({ name: 'bare', html_url: 'https://github.com/octo/bare' });
    assert.equal(repo.description, '');
    assert.equal(repo.homepage, '');
    assert.equal(repo.language, '');
    assert.equal(repo.stars, 0);
    assert.equal(repo.forks, 0);
    assert.deepEqual(repo.topics, []);
    assert.equal(repo.pushedAt, 0);
    assert.equal(repo.isFork, false);
    assert.equal(repo.isArchived, false);
  });

  test('rejects objects without a usable name or github.com URL', () => {
    assert.equal(normalizeRepo(null), null);
    assert.equal(normalizeRepo('string'), null);
    assert.equal(normalizeRepo({ html_url: 'https://github.com/o/x' }), null);
    assert.equal(normalizeRepo({ name: '   ', html_url: 'https://github.com/o/x' }), null);
    assert.equal(normalizeRepo({ name: 'x' }), null);
    assert.equal(normalizeRepo({ name: 'x', html_url: 'https://evil.example/o/x' }), null);
    assert.equal(normalizeRepo({ name: 'x', html_url: 'http://github.com/o/x' }), null);
    assert.equal(normalizeRepo({ name: 'x', html_url: 'javascript:alert(1)' }), null);
  });

  test('survives type confusion in every field', () => {
    const repo = normalizeRepo({
      name: 'x',
      html_url: 'https://github.com/o/x',
      description: { toString: 'nope' },
      homepage: 42,
      language: ['Go'],
      stargazers_count: '7',
      forks_count: -3,
      topics: 'not-a-list',
      pushed_at: 'not a date',
      fork: 'yes',
      archived: 1,
    });
    assert.equal(repo.description, '');
    assert.equal(repo.homepage, '');
    assert.equal(repo.language, '');
    assert.equal(repo.stars, 0);
    assert.equal(repo.forks, 0);
    assert.deepEqual(repo.topics, []);
    assert.equal(repo.pushedAt, 0);
    assert.equal(repo.isFork, false);
    assert.equal(repo.isArchived, false);
  });

  test('drops dangerous homepages but keeps the repo', () => {
    const repo = normalizeRepo(rawRepo('x', { homepage: 'javascript:alert(document.cookie)' }));
    assert.equal(repo.homepage, '');
    assert.equal(repo.url, 'https://github.com/octo/x');
  });

  test('caps topic count, description length and drops empty topics', () => {
    const repo = normalizeRepo(
      rawRepo('x', { description: 'd'.repeat(1000), topics: ['', '  ', ...Array.from({ length: 30 }, (_, i) => `t${i}`)] }),
    );
    assert.equal(repo.description.length, 350);
    assert.equal(repo.topics.length, 12);
    assert.equal(repo.topics[0], 't0');
  });
});

describe('normalizeRepos', () => {
  test('returns [] for anything that is not an array', () => {
    for (const bad of [null, undefined, {}, 'x', 3]) assert.deepEqual(normalizeRepos(bad), []);
  });

  test('drops invalid entries and duplicate names (case-insensitive)', () => {
    const repos = normalizeRepos([rawRepo('a'), null, { nope: true }, rawRepo('A'), rawRepo('b')]);
    assert.deepEqual(
      repos.map((repo) => repo.name),
      ['a', 'b'],
    );
  });

  test('removes hidden repositories case-insensitively', () => {
    const repos = normalizeRepos([rawRepo('keep'), rawRepo('Profile'), rawRepo('other')], { hiddenRepos: ['profile', 'OTHER'] });
    assert.deepEqual(
      repos.map((repo) => repo.name),
      ['keep'],
    );
  });

  test('blanks boilerplate descriptions, ignoring case and punctuation', () => {
    const bio = 'Software Developer | Building cool things for the web | Open Source Enthusiast';
    const repos = normalizeRepos(
      [
        rawRepo('a', { description: bio }),
        rawRepo('b', { description: 'software developer - building cool things for the web - open source enthusiast.' }),
        rawRepo('c', { description: 'A genuinely useful description' }),
      ],
      { ignoredDescriptions: [bio] },
    );
    assert.deepEqual(
      repos.map((repo) => repo.description),
      ['', '', 'A genuinely useful description'],
    );
  });

  test('applies title/description overrides (partial overrides keep the rest)', () => {
    const repos = normalizeRepos(
      [rawRepo('Alpha', { description: 'api description' }), rawRepo('Beta', { description: 'api description' })],
      { projects: { alpha: { title: 'Pretty Alpha', description: 'Custom text' }, Beta: { title: 'Only title' } } },
    );
    assert.equal(repos[0].title, 'Pretty Alpha');
    assert.equal(repos[0].description, 'Custom text');
    assert.equal(repos[0].name, 'Alpha');
    assert.equal(repos[1].title, 'Only title');
    assert.equal(repos[1].description, 'api description');
  });

  test('an override description wins over an ignored (boilerplate) one', () => {
    const [repo] = normalizeRepos([rawRepo('a', { description: 'boiler plate' })], {
      ignoredDescriptions: ['Boiler-plate'],
      projects: { a: { description: 'Real description' } },
    });
    assert.equal(repo.description, 'Real description');
  });
});

describe('canonicalText', () => {
  test('lower-cases and collapses punctuation/whitespace', () => {
    assert.equal(canonicalText('  A | B —  C! '), 'a b c');
    assert.equal(canonicalText(null), '');
  });
});

describe('sortRepos', () => {
  const repos = normalizeRepos([
    rawRepo('b-old', { pushed_at: '2026-01-01T00:00:00Z', stargazers_count: 5 }),
    rawRepo('a-new', { pushed_at: '2026-10-01T00:00:00Z', stargazers_count: 1 }),
    rawRepo('c-new', { pushed_at: '2026-10-01T00:00:00Z', stargazers_count: 5 }),
    rawRepo('Project10', { pushed_at: '2025-01-01T00:00:00Z' }),
    rawRepo('Project2', { pushed_at: '2025-01-01T00:00:00Z' }),
  ]);
  const names = (list) => list.map((repo) => repo.name);

  test('updated: newest first, ties broken by title', () => {
    assert.deepEqual(names(sortRepos(repos, 'updated')), ['a-new', 'c-new', 'b-old', 'Project2', 'Project10']);
  });

  test('stars: most first, then newest, then title', () => {
    assert.deepEqual(names(sortRepos(repos, 'stars')), ['c-new', 'b-old', 'a-new', 'Project2', 'Project10']);
  });

  test('name: natural order, so Project2 sorts before Project10', () => {
    assert.deepEqual(names(sortRepos(repos, 'name')), ['a-new', 'b-old', 'c-new', 'Project2', 'Project10']);
  });

  test('does not mutate its input and falls back to "updated" for unknown modes', () => {
    const before = names(repos);
    sortRepos(repos, 'name');
    assert.deepEqual(names(repos), before);
    assert.deepEqual(names(sortRepos(repos, 'bogus')), names(sortRepos(repos, 'updated')));
  });
});

describe('filterRepos', () => {
  const repos = normalizeRepos([
    rawRepo('go-ml', { language: 'Go', description: 'Machine learning platform', topics: ['onnx'] }),
    rawRepo('studio', { language: 'HTML', description: 'Creator workspace for YouTube kits' }),
    rawRepo('forked-lib', { language: 'Go', fork: true, description: 'A fork' }),
    rawRepo('no-language', { language: null, description: 'Docs only' }),
  ]);
  const names = (list) => list.map((repo) => repo.name);

  test('hides forks unless asked', () => {
    assert.deepEqual(names(filterRepos(repos)), ['go-ml', 'studio', 'no-language']);
    assert.deepEqual(names(filterRepos(repos, { includeForks: true })), ['go-ml', 'studio', 'forked-lib', 'no-language']);
  });

  test('filters by language, case-insensitively', () => {
    assert.deepEqual(names(filterRepos(repos, { language: 'go' })), ['go-ml']);
    assert.deepEqual(names(filterRepos(repos, { language: 'GO', includeForks: true })), ['go-ml', 'forked-lib']);
  });

  test('search matches every term across title, name, description, language and topics', () => {
    assert.deepEqual(names(filterRepos(repos, { query: 'machine learning' })), ['go-ml']);
    assert.deepEqual(names(filterRepos(repos, { query: 'ONNX' })), ['go-ml']);
    assert.deepEqual(names(filterRepos(repos, { query: 'html youtube' })), ['studio']);
    assert.deepEqual(names(filterRepos(repos, { query: 'go youtube' })), []);
    assert.deepEqual(names(filterRepos(repos, { query: '   ' })), ['go-ml', 'studio', 'no-language']);
  });

  test('combines query, language and forks', () => {
    assert.deepEqual(names(filterRepos(repos, { query: 'fork', language: 'Go', includeForks: true })), ['forked-lib']);
    assert.deepEqual(names(filterRepos(repos, { query: 'fork', language: 'Go' })), []);
  });
});

describe('languages and summary', () => {
  test('languageColor uses known colours and a stable fallback', () => {
    assert.equal(languageColor('Go'), '#00add8');
    assert.equal(languageColor('Zig'), languageColor('Zig'));
    assert.match(languageColor('Zig'), /^hsl\(\d{1,3} 62% 58%\)$/);
    assert.notEqual(languageColor('Zig'), languageColor('Nim'));
  });

  test('languageColor is not fooled by Object.prototype property names', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.match(languageColor(name), /^hsl\(/, name);
    }
  });

  test('languageBreakdown counts, sorts and normalises shares', () => {
    const repos = normalizeRepos([
      rawRepo('a', { language: 'Go' }),
      rawRepo('b', { language: 'Python' }),
      rawRepo('c', { language: 'Go' }),
      rawRepo('d', { language: null }),
      rawRepo('e', { language: 'HTML' }),
    ]);
    const breakdown = languageBreakdown(repos);
    assert.deepEqual(
      breakdown.map((entry) => [entry.name, entry.count]),
      [
        ['Go', 2],
        ['HTML', 1],
        ['Python', 1],
      ],
    );
    assert.equal(breakdown[0].share, 0.5);
    assert.equal(
      breakdown.reduce((sum, entry) => sum + entry.share, 0),
      1,
    );
    assert.deepEqual(languageBreakdown([]), []);
  });

  test('summarize describes own work only (forks excluded)', () => {
    const summary = summarize(
      normalizeRepos([
        rawRepo('a', { language: 'Go', stargazers_count: 3, pushed_at: '2026-10-01T00:00:00Z' }),
        rawRepo('b', { language: 'Python', stargazers_count: 4, pushed_at: '2026-10-20T00:00:00Z' }),
        rawRepo('c', { language: 'Rust', stargazers_count: 100, fork: true, pushed_at: '2026-11-01T00:00:00Z' }),
      ]),
    );
    assert.equal(summary.count, 2);
    assert.equal(summary.stars, 7);
    assert.equal(summary.lastPushAt, Date.UTC(2026, 9, 20));
    assert.deepEqual(
      summary.languages.map((language) => language.name),
      ['Go', 'Python'],
    );
  });

  test('summarize copes with an empty list', () => {
    assert.deepEqual(summarize([]), { count: 0, stars: 0, languages: [], lastPushAt: 0 });
  });
});
