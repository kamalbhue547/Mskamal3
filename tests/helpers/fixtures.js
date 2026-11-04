// Shared test fixtures. `rawRepo` mimics the shape of a GitHub API repository,
// including plenty of fields the site deliberately ignores.

export const OWNER = 'octo';
export const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);

export function rawRepo(name, extra = {}) {
  return {
    id: 1234,
    node_id: 'R_kgDOxxxx',
    name,
    full_name: `${OWNER}/${name}`,
    private: false,
    owner: { login: OWNER },
    html_url: `https://github.com/${OWNER}/${name}`,
    description: `${name} description`,
    homepage: null,
    language: 'JavaScript',
    stargazers_count: 0,
    forks_count: 0,
    topics: [],
    pushed_at: '2026-10-01T00:00:00Z',
    fork: false,
    archived: false,
    ...extra,
  };
}

/** A minimal in-memory stand-in for window.localStorage. */
export function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => void data.set(key, String(value)),
    removeItem: (key) => void data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

/** Storage whose every operation throws, like Safari private mode or a blocked-cookies profile. */
export function brokenStorage() {
  const fail = () => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: fail, setItem: fail, removeItem: fail };
}
