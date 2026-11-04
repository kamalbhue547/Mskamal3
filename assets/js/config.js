// Loads and validates site.config.json. Validation produces clear errors so a
// typo in the config fails loudly in the UI rather than rendering nonsense.

// GitHub usernames: alphanumeric or single hyphens, no leading/trailing hyphen, max 39 chars.
const USERNAME_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

function stringList(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`"${field}" must be a list of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function projectOverrides(value) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"projects" must be an object keyed by repository name');
  }
  const overrides = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`"projects.${name}" must be an object with optional "title" and "description"`);
    }
    for (const field of ['title', 'description']) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        throw new Error(`"projects.${name}.${field}" must be a string`);
      }
    }
    overrides[name] = { title: entry.title, description: entry.description };
  }
  return overrides;
}

/**
 * Validates a parsed site.config.json and fills in defaults.
 *
 * @param {unknown} raw
 * @returns {{ username: string, hiddenRepos: string[], ignoredDescriptions: string[],
 *             projects: Record<string, { title?: string, description?: string }>, backdrop: boolean }}
 */
export function parseConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('site.config.json must contain a JSON object');
  }
  const username = typeof raw.username === 'string' ? raw.username.trim() : '';
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('"username" must be a valid GitHub username');
  }
  if (raw.backdrop !== undefined && typeof raw.backdrop !== 'boolean') {
    throw new Error('"backdrop" must be true or false');
  }
  return {
    username,
    hiddenRepos: stringList(raw.hiddenRepos, 'hiddenRepos'),
    ignoredDescriptions: stringList(raw.ignoredDescriptions, 'ignoredDescriptions'),
    projects: projectOverrides(raw.projects),
    backdrop: raw.backdrop !== false,
  };
}

/** Fetches and validates the configuration file. */
export async function loadConfig({ fetch: doFetch, url }) {
  let response;
  try {
    response = await doFetch(url, { headers: { Accept: 'application/json' } });
  } catch (cause) {
    throw new Error('Could not load site.config.json', { cause });
  }
  if (!response.ok) throw new Error(`Could not load site.config.json (HTTP ${response.status})`);
  let json;
  try {
    json = await response.json();
  } catch (cause) {
    throw new Error('site.config.json is not valid JSON', { cause });
  }
  return parseConfig(json);
}
