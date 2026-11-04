// fetch() test doubles built on the real Response class, so status handling,
// headers and .json() behave exactly as in a browser.

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * Builds a fetch stub from a handler `(url, init, callNumber) => Response | Promise<Response>`.
 * The returned function records every call in `.calls`.
 */
export function stubFetch(handler) {
  const calls = [];
  const stub = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init, calls.length);
  };
  stub.calls = calls;
  return stub;
}

/**
 * Routes by URL: `routes` maps a substring of the URL to a Response factory
 * (or a plain value that is served as JSON). Unmatched URLs return 404.
 */
export function routedFetch(routes) {
  return stubFetch((url) => {
    for (const [fragment, value] of Object.entries(routes)) {
      if (url.includes(fragment)) {
        const result = typeof value === 'function' ? value(url) : value;
        return result instanceof Response ? result : jsonResponse(result);
      }
    }
    return jsonResponse({ message: 'Not Found' }, { status: 404 });
  });
}

/** A fetch that never settles until its AbortSignal fires, to exercise timeouts. */
export function hangingFetch() {
  return (_url, { signal }) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
}

/** A fetch that rejects like a browser does when the network is down. */
export function offlineFetch() {
  return async () => {
    throw new TypeError('Failed to fetch');
  };
}
