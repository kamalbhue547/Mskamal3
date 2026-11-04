#!/usr/bin/env node
// Zero-dependency static file server for local development and previews.
//
//   npm run dev                                   http://localhost:4173
//   node scripts/serve.mjs --port 8080            pick a port
//   node scripts/serve.mjs --host 0.0.0.0         listen on all interfaces (containers, LAN)
//   HOST=0.0.0.0 PORT=8080 npm run dev            same, via environment variables
//
// Only GET and HEAD are served. Requests are confined to the project root:
// dot-files, node_modules, "..", drive letters, percent-encoded "..%2f" tricks
// and symbolic links that lead outside the root are all refused.

import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_PORT = 4173;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Splits a request target such as "/a/b?x=1#y" into its path and query string.
 *
 * This is done by hand on purpose: `new URL("//a/b", base)` would read "a" as a
 * host name, so "//assets/app.js" would silently resolve to "/b" and the
 * ".." / dot-file checks would run on a path other than the one requested.
 */
function splitTarget(target) {
  const withoutFragment = String(target).split('#', 1)[0];
  const queryStart = withoutFragment.indexOf('?');
  return queryStart === -1
    ? { pathname: withoutFragment, search: '' }
    : { pathname: withoutFragment.slice(0, queryStart), search: withoutFragment.slice(queryStart) };
}

/**
 * Maps a request URL to a file path inside `rootDir`.
 * @returns {{ status: 200, path: string } | { status: 400 | 403 }}
 */
export function resolveRequestPath(rootDir, requestUrl) {
  const { pathname: rawPath } = splitTarget(requestUrl);
  if (!rawPath.startsWith('/')) return { status: 400 }; // only the origin form ("/path") is supported

  let pathname;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return { status: 400 }; // malformed percent-encoding
  }
  if (pathname.includes('\0')) return { status: 400 };

  // Split on both separators *after* decoding, so "..%2f" and "..%5c" are seen as ".." segments.
  const segments = pathname.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    // A leading dot covers "..", ".git", ".env" and every other hidden file.
    if (segment.startsWith('.') || segment === 'node_modules' || segment.includes(':')) return { status: 403 };
  }

  const path = join(rootDir, ...segments);
  if (path !== rootDir && !path.startsWith(rootDir + sep)) return { status: 403 };
  return { status: 200, path };
}

/** "/sub/dir/" for a directory under the root, always starting with exactly one slash. */
function directoryUrl(rootDir, directory) {
  const parts = relative(rootDir, directory).split(sep).filter(Boolean);
  return parts.length === 0 ? '/' : `/${parts.map(encodeURIComponent).join('/')}/`;
}

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  response.end(body);
}

/** @param {{ root?: string }} [options] */
export function createServer({ root = DEFAULT_ROOT } = {}) {
  const rootDir = resolve(root);
  let realRoot; // resolved on first use so that createServer() stays synchronous

  /** True when `file` really lives inside the root once symbolic links are resolved. */
  async function isInsideRoot(file) {
    realRoot ??= await realpath(rootDir);
    const real = await realpath(file).catch(() => null);
    return real !== null && (real === realRoot || real.startsWith(realRoot + sep));
  }

  async function handle(request, response) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply(response, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
    }

    const target = splitTarget(request.url ?? '/');
    const resolved = resolveRequestPath(rootDir, request.url ?? '/');
    if (resolved.status !== 200) return reply(response, resolved.status, resolved.status === 400 ? 'Bad Request' : 'Forbidden');

    let path = resolved.path;
    let info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      if (!target.pathname.endsWith('/')) {
        // Built from the normalised path, so "//sub" can never become a protocol-relative redirect.
        return reply(response, 301, '', { Location: `${directoryUrl(rootDir, path)}${target.search}` });
      }
      path = join(path, 'index.html');
      info = await stat(path).catch(() => null);
    }
    if (!info?.isFile()) return reply(response, 404, 'Not Found');
    if (!(await isInsideRoot(path))) return reply(response, 403, 'Forbidden');

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') return response.end();

    const stream = createReadStream(path);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  }

  return createHttpServer((request, response) => {
    handle(request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else reply(response, 500, 'Internal Server Error');
    });
  });
}

/** Digits only: Number() would also accept "", " ", "1e3", "0x50" and "80.0". */
const parsePort = (value) => (typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN);

/** Parses CLI flags, falling back to HOST/PORT environment variables. */
export function parseArgs(argv, env = process.env) {
  const options = { host: env.HOST || '127.0.0.1', port: env.PORT ? parsePort(env.PORT) : DEFAULT_PORT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port' || arg === '-p') options.port = parsePort(argv[(index += 1)]);
    else if (arg === '--host' || arg === '-H') options.host = argv[(index += 1)] ?? '';
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error('The port must be an integer between 0 and 65535');
  }
  if (!options.host) throw new Error('The host must not be empty');
  return options;
}

const USAGE = `Usage: node scripts/serve.mjs [--port <number>] [--host <address>]

  -p, --port   Port to listen on (default ${DEFAULT_PORT}, or $PORT)
  -H, --host   Address to bind (default 127.0.0.1, or $HOST). Use 0.0.0.0 to expose it.
  -h, --help   Show this help
`;

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const server = createServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${options.port} is already in use. Try --port <other>.` : error.message);
    process.exit(1);
  });
  server.listen(options.port, options.host, () => {
    const { port } = server.address();
    const where = options.host === '0.0.0.0' || options.host === '::' ? 'all interfaces' : options.host;
    console.log(`Serving ${DEFAULT_ROOT}\n  http://localhost:${port}  (listening on ${where})\nPress Ctrl+C to stop.`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
