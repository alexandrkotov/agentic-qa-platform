// Dependency-free static file server — the `startCommand` of a `process`
// component whose build output is a folder of static files (see
// descriptor/components/process.ts and bootstrap/deployProcessTarget.ts).
// Plain .mjs on purpose: it is spawned with bare `node`, no tsx, no npm
// install, nothing to fetch at deploy time.
//
//   node staticServer.mjs --root <dir> --port <n> [--host 0.0.0.0]
//
// Binds 0.0.0.0 by default, not 127.0.0.1: the workbench container's
// published ports (docker-compose.yml) forward to the container's own
// interface, so a loopback-only listener would be unreachable from the CI
// runner and from the host.
//
// Scope is exactly what serving a built static site needs: correct content
// types (WebAssembly needs application/wasm for streaming instantiation),
// index.html for directories, a redirect to the trailing slash so a
// relative-base app (`./assets/...`) resolves under /editor/ the way it does
// on a real static host, and no way out of the root folder. No listing, no
// range requests, no compression.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const root = resolve(args.get('--root') ?? '.');
const port = Number(args.get('--port') ?? 8080);
const host = args.get('--host') ?? '0.0.0.0';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`invalid --port: ${args.get('--port')}`);
  process.exit(2);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ecatm': 'application/octet-stream',
  '.sch': 'application/octet-stream',
};

async function statOrNull(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  // normalize() collapses "..", then the prefix check proves the result is
  // still inside root — checking after normalization, not before.
  const target = normalize(join(root, pathname));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  let file = target;
  let info = await statOrNull(file);
  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) {
      // Preserve the query string — e.g. /viewer?src=... must stay usable.
      const query = new URL(req.url ?? '/', 'http://x').search;
      res.writeHead(301, { Location: `${pathname}/${query}` }).end();
      return;
    }
    file = join(file, 'index.html');
    info = await statOrNull(file);
  }
  if (!info?.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': info.size,
    // A freshly deployed build must never be masked by a cached older one.
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(port, host, () => {
  console.log(`static server listening on http://${host}:${port} (root: ${root})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Idle keep-alive connections would otherwise hold close() open.
    server.closeAllConnections?.();
  });
}
