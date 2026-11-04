import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createServer, parseArgs, resolveRequestPath } from '../scripts/serve.mjs';

const SCRIPT = new URL('../scripts/serve.mjs', import.meta.url).pathname;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

let tempDir;
let root;
let server;
let port;

/** Raw HTTP request: unlike fetch(), it sends the path exactly as given (no ".." normalisation). */
function send(path, { method = 'GET' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolvePromise({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'mskamal3-serve-'));
  root = join(tempDir, 'site');
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'empty'));
  mkdirSync(join(root, '.hidden'));
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });

  writeFileSync(join(tempDir, 'outside.txt'), 'TOP SECRET');
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>home</title>');
  writeFileSync(join(root, 'sub', 'index.html'), '<!doctype html><title>sub</title>');
  writeFileSync(join(root, 'style.css'), 'body{}');
  writeFileSync(join(root, 'app.js'), 'export {};');
  writeFileSync(join(root, 'module.mjs'), 'export {};');
  writeFileSync(join(root, 'data.json'), '{"ok":true}');
  writeFileSync(join(root, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(root, 'pixel.png'), PNG);
  writeFileSync(join(root, 'notes.txt'), 'hello');
  writeFileSync(join(root, 'blob.xyz'), 'bytes');
  writeFileSync(join(root, 'a b.txt'), 'spaced');
  writeFileSync(join(root, '.secret'), 'nope');
  writeFileSync(join(root, '.hidden', 'x.txt'), 'nope');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'nope');

  server = createServer({ root });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  port = server.address().port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolvePromise) => server.close(resolvePromise));
  rmSync(tempDir, { recursive: true, force: true });
});

describe('serving files', () => {
  test('serves index.html for "/" with the right headers', async () => {
    const response = await send('/');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['cache-control'], 'no-cache');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.match(response.body.toString(), /<title>home<\/title>/);
  });

  for (const [file, type] of [
    ['/style.css', 'text/css; charset=utf-8'],
    ['/app.js', 'text/javascript; charset=utf-8'],
    ['/module.mjs', 'text/javascript; charset=utf-8'],
    ['/data.json', 'application/json; charset=utf-8'],
    ['/icon.svg', 'image/svg+xml'],
    ['/pixel.png', 'image/png'],
    ['/notes.txt', 'text/plain; charset=utf-8'],
    ['/blob.xyz', 'application/octet-stream'],
  ]) {
    test(`${file} is served as ${type}`, async () => {
      const response = await send(file);
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], type);
    });
  }

  test('sends binary files byte for byte', async () => {
    const response = await send('/pixel.png');
    assert.deepEqual(response.body, PNG);
    assert.equal(response.headers['content-length'], String(PNG.length));
  });

  test('redirects a directory to its trailing-slash form, keeping the query string', async () => {
    const response = await send('/sub?x=1');
    assert.equal(response.status, 301);
    assert.equal(response.headers.location, '/sub/?x=1');
  });

  test('serves the index.html of a directory, and 404s a directory without one', async () => {
    assert.match((await send('/sub/')).body.toString(), /<title>sub<\/title>/);
    assert.equal((await send('/empty/')).status, 404);
  });

  test('decodes percent-encoded file names and ignores query strings', async () => {
    assert.equal((await send('/a%20b.txt?v=3')).body.toString(), 'spaced');
  });

  test('HEAD returns the same headers as GET and no body', async () => {
    const get = await send('/style.css');
    const head = await send('/style.css', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], get.headers['content-length']);
    assert.equal(head.headers['content-type'], get.headers['content-type']);
    assert.equal(head.body.length, 0);
  });

  test('answers 404 for files that do not exist', async () => {
    assert.equal((await send('/missing.html')).status, 404);
    assert.equal((await send('/sub/missing/deeper.js')).status, 404);
  });

  test('allows only GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await send('/', { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.allow, 'GET, HEAD');
    }
  });
});

describe('staying inside the project root', () => {
  for (const path of [
    '/.secret',
    '/.hidden/x.txt',
    '/.git/config',
    '/node_modules/pkg/index.js',
    '/..%2foutside.txt',
    '/..%2Foutside.txt',
    '/%2e%2e%2foutside.txt',
    '/..%5coutside.txt',
    '/sub/..%2f..%2foutside.txt',
    '/C:/Windows/win.ini',
  ]) {
    test(`refuses ${path}`, async () => {
      const response = await send(path);
      assert.equal(response.status, 403);
      assert.doesNotMatch(response.body.toString(), /TOP SECRET/);
    });
  }

  test('a literal "../" segment is refused outright', async () => {
    const response = await send('/../outside.txt');
    assert.equal(response.status, 403);
    assert.doesNotMatch(response.body.toString(), /TOP SECRET/);
  });

  test('a double slash is an empty path segment, not a host name', async () => {
    assert.equal((await send('//style.css')).status, 200);
    assert.equal((await send('//sub//')).status, 200);
    assert.equal((await send('//.secret')).status, 403, 'the dot-file rule must see the real path');
  });

  test('redirects never turn into protocol-relative URLs', async () => {
    for (const path of ['//sub', '///sub', '/sub//..%2fsub']) {
      const response = await send(path);
      if (response.status === 301) assert.match(response.headers.location, /^\/(?!\/)/, `${path} -> ${response.headers.location}`);
    }
    assert.equal((await send('//sub')).headers.location, '/sub/');
  });

  test('refuses request targets that are not in origin form', async () => {
    for (const path of ['http://evil.example/style.css', '*']) assert.equal((await send(path)).status, 400, path);
  });

  test('rejects malformed percent-encoding and NUL bytes with 400', async () => {
    for (const path of ['/%E0%A4%A', '/%', '/%00', '/index.html%00.png']) assert.equal((await send(path)).status, 400, path);
  });

  describe('symbolic links', () => {
    let linksWork = true;
    before(() => {
      try {
        symlinkSync(join(tempDir, 'outside.txt'), join(root, 'escape.txt'));
        symlinkSync(tempDir, join(root, 'escape-dir'), 'dir');
        symlinkSync(join(root, 'notes.txt'), join(root, 'inside.txt'));
      } catch {
        linksWork = false; // e.g. Windows without the privilege
      }
    });

    test('does not follow a file symlink that points outside the root', async (t) => {
      if (!linksWork) return t.skip('symlinks are unavailable here');
      const response = await send('/escape.txt');
      assert.equal(response.status, 403);
      assert.doesNotMatch(response.body.toString(), /TOP SECRET/);
    });

    test('does not follow a directory symlink that points outside the root', async (t) => {
      if (!linksWork) return t.skip('symlinks are unavailable here');
      assert.equal((await send('/escape-dir/outside.txt')).status, 403);
    });

    test('still serves a symlink that stays inside the root', async (t) => {
      if (!linksWork) return t.skip('symlinks are unavailable here');
      assert.equal((await send('/inside.txt')).body.toString(), 'hello');
    });
  });
});

describe('resolveRequestPath', () => {
  const rootDir = resolve('/srv/site');

  test('maps URLs onto the root', () => {
    assert.deepEqual(resolveRequestPath(rootDir, '/'), { status: 200, path: rootDir });
    assert.deepEqual(resolveRequestPath(rootDir, '/a/b.txt?x=1#y'), { status: 200, path: join(rootDir, 'a', 'b.txt') });
    assert.deepEqual(resolveRequestPath(rootDir, '//a//b.txt'), { status: 200, path: join(rootDir, 'a', 'b.txt') });
    assert.deepEqual(resolveRequestPath(rootDir, '/caf%C3%A9.txt'), { status: 200, path: join(rootDir, 'café.txt') });
  });

  test('refuses dot segments, hidden files, node_modules and drive letters', () => {
    for (const url of ['/.env', '/a/.git', '/%2e%2e/x', '/node_modules/x', '/a/b/..%2f..%2f..%2fetc/passwd', '/c:/x', '/a%5c..%5c..%5cx']) {
      assert.equal(resolveRequestPath(rootDir, url).status, 403, url);
    }
  });

  test('flags malformed input as a bad request', () => {
    for (const url of ['/%zz', '/%E0%A4', '/a%00b']) assert.equal(resolveRequestPath(rootDir, url).status, 400, url);
  });
});

describe('parseArgs', () => {
  test('defaults to localhost:4173 so nothing is exposed by accident', () => {
    assert.deepEqual(parseArgs([], {}), { host: '127.0.0.1', port: 4173, help: false });
  });

  test('reads HOST and PORT from the environment, and lets flags override them', () => {
    assert.deepEqual(parseArgs([], { HOST: '0.0.0.0', PORT: '8080' }), { host: '0.0.0.0', port: 8080, help: false });
    assert.deepEqual(parseArgs(['--port', '9000', '--host', '::1'], { HOST: '0.0.0.0', PORT: '8080' }), { host: '::1', port: 9000, help: false });
    assert.deepEqual(parseArgs(['-p', '3000', '-H', 'localhost'], {}), { host: 'localhost', port: 3000, help: false });
  });

  test('an empty PORT or HOST variable means "unset"', () => {
    assert.deepEqual(parseArgs([], { HOST: '', PORT: '' }), { host: '127.0.0.1', port: 4173, help: false });
  });

  test('accepts 0 (any free port) and 65535', () => {
    assert.equal(parseArgs(['--port', '0'], {}).port, 0);
    assert.equal(parseArgs(['--port', '65535'], {}).port, 65535);
  });

  test('--help and -h set the help flag', () => {
    assert.equal(parseArgs(['--help'], {}).help, true);
    assert.equal(parseArgs(['-h'], {}).help, true);
  });

  for (const value of ['abc', '-1', '65536', '1.5', '', ' ', '1e3', '0x50', '80.0', '+80', 'NaN', 'Infinity']) {
    test(`rejects the port ${JSON.stringify(value)}`, () => {
      assert.throws(() => parseArgs(['--port', value], {}), /port must be an integer/);
    });
  }

  test('rejects a non-numeric PORT variable and a flag with no value', () => {
    assert.throws(() => parseArgs([], { PORT: 'abc' }), /port must be an integer/);
    assert.throws(() => parseArgs(['--port'], {}), /port must be an integer/);
    assert.throws(() => parseArgs(['--host'], {}), /host must not be empty/);
    assert.throws(() => parseArgs(['--host', ''], {}), /host must not be empty/);
  });

  test('rejects unknown options instead of ignoring them', () => {
    assert.throws(() => parseArgs(['--prot', '80'], {}), /Unknown option: --prot/);
    assert.throws(() => parseArgs(['serve'], {}), /Unknown option: serve/);
  });
});

test('the real project root is served: index.html, data and config, but never .git', async () => {
  const projectServer = createServer();
  await new Promise((resolvePromise) => projectServer.listen(0, '127.0.0.1', resolvePromise));
  const projectPort = projectServer.address().port;
  try {
    const get = async (path) => {
      const response = await fetch(`http://127.0.0.1:${projectPort}${path}`);
      return { status: response.status, text: await response.text(), type: response.headers.get('content-type') };
    };
    assert.match((await get('/')).text, /<title>/);
    assert.equal(JSON.parse((await get('/site.config.json')).text).username.length > 0, true);
    assert.ok(Array.isArray(JSON.parse((await get('/data/repos.snapshot.json')).text).repos));
    assert.equal((await get('/assets/js/main.js')).type, 'text/javascript; charset=utf-8');
    assert.equal((await get('/.git/config')).status, 403);
    assert.ok(statSync(new URL('../.nojekyll', import.meta.url)).isFile());
  } finally {
    projectServer.closeAllConnections();
    await new Promise((resolvePromise) => projectServer.close(resolvePromise));
  }
});

describe('command line', () => {
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 20_000 });

  test('--help prints the usage and exits 0 without starting a server', () => {
    const result = run('--help');
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Usage: node scripts\/serve\.mjs/);
    assert.match(result.stdout, /127\.0\.0\.1/);
  });

  test('bad arguments exit with status 2 and say what is wrong', () => {
    for (const [args, message] of [
      [['--port', 'abc'], /port must be an integer/],
      [['--port', ''], /port must be an integer/],
      [['--host', ''], /host must not be empty/],
      [['--nope'], /Unknown option: --nope/],
    ]) {
      const result = run(...args);
      assert.equal(result.status, 2, args.join(' '));
      assert.match(result.stderr, message);
      assert.match(result.stderr, /Usage:/);
    }
  });

  test('starts, serves the site, and shuts down cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, [SCRIPT, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise((resolvePromise, reject) => {
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
          const match = output.match(/http:\/\/localhost:(\d+)/);
          if (match) resolvePromise(`http://127.0.0.1:${match[1]}/`);
        });
        child.once('exit', (code) => reject(new Error(`exited early with ${code}`)));
        setTimeout(() => reject(new Error('did not start in time')), 10_000).unref();
      });
      const response = await fetch(url);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /<title>/);

      child.kill('SIGTERM');
      const [code] = await once(child, 'exit');
      assert.equal(code, 0);
    } finally {
      child.kill('SIGKILL');
    }
  });

  test('explains a port that is already taken and exits 1', async () => {
    const blocker = createNetServer();
    await new Promise((resolvePromise) => blocker.listen(0, '127.0.0.1', resolvePromise));
    try {
      const { port: taken } = blocker.address();
      const child = spawn(process.execPath, [SCRIPT, '--port', String(taken)], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => (stderr += chunk));
      const [code] = await once(child, 'exit');
      assert.equal(code, 1);
      assert.match(stderr, new RegExp(`Port ${taken} is already in use`));
    } finally {
      await new Promise((resolvePromise) => blocker.close(resolvePromise));
    }
  });
});
