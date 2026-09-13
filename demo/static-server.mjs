/**
 * A plain static file server for the web build, shared by the `demo` smoke tier and
 * demo/measure.mjs. No framework: the point of the demo is that it boots from ANY static host,
 * so the server that proves it is the smallest one that can serve a directory.
 *
 * The build's base path is read from the built index.html (the first module script src, e.g.
 * `/demo/assets/index-*.js` or `/kangentic/assets/...`), so the tree is mounted wherever the
 * build expects to live and a Pages-style base can be smoke-tested locally.
 *
 *   import { startDemoServer } from './static-server.mjs';
 *   const server = await startDemoServer({ distDir: 'dist/demo' });
 *   server.url  // http://127.0.0.1:<port>/demo/
 *   await server.close();
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** Reads the base path the build was made for out of its index.html. */
export function readBuildBase(distDir) {
  const indexPath = path.join(distDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`No web build at ${indexPath}. Run "npm run build:demo" first.`);
  }
  const html = fs.readFileSync(indexPath, 'utf8');
  const match = html.match(/<script[^>]+type="module"[^>]+src="([^"]+)\/assets\//);
  if (!match) throw new Error(`Could not find the module script in ${indexPath}; is this a Vite build?`);
  return `${match[1]}/`;
}

export function startDemoServer({ distDir, port = 0, host = '127.0.0.1', extraRoutes = {} } = {}) {
  const absoluteDist = path.resolve(distDir);
  const base = readBuildBase(absoluteDist);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (extraRoutes[pathname]) {
      const extra = extraRoutes[pathname];
      response.writeHead(200, { 'content-type': extra.contentType ?? 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(extra.body);
      return;
    }
    if (!pathname.startsWith(base)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end(`Not found: the build is mounted at ${base}`);
      return;
    }
    pathname = pathname.slice(base.length);
    if (pathname === '' || pathname.endsWith('/')) pathname += 'index.html';
    const filePath = path.join(absoluteDist, pathname);
    if (!filePath.startsWith(absoluteDist) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('Not found');
      return;
    }
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, {
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': fs.statSync(filePath).size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const boundPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        base,
        port: boundPort,
        origin: `http://${host}:${boundPort}`,
        url: `http://${host}:${boundPort}${base}`,
        /** Extra routes can be added after start: `server.routes['/bench.html'] = { body }`. */
        routes: extraRoutes,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
