#!/usr/bin/env node
// Zero-dependency static server for ./app (local development).
//
//   npm start                 → http://localhost:8080/
//   PORT=3000 npm start       → another port (PORT=0 picks a free one)
//   HOST=127.0.0.1 npm start  → local machine only (default 0.0.0.0: reachable from the Wi-Fi)
//
// Can also be imported (e.g. by tests): `const { server, url, close } = await startServer({ port: 0 })`.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'app');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.wav': 'audio/wav',
};

function mimeType(filePath) {
  return MIME_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function sendText(res, status, text, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(text);
}

/**
 * Maps a URL pathname to a file inside `root`, or null if it would escape it.
 * Rejects malformed percent-encoding and NUL bytes.
 */
function resolveInRoot(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const target = resolve(root, `.${sep}${decoded.replace(/^[/\\]+/, '')}`);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** Creates the request handler for a given root directory. */
export function createHandler(root = DEFAULT_ROOT) {
  const rootDir = resolve(root);

  return async function handle(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendText(res, 405, 'Méthode non autorisée', { Allow: 'GET, HEAD' });
        return;
      }

      const url = new URL(req.url || '/', 'http://localhost');
      let filePath = resolveInRoot(rootDir, url.pathname);
      if (!filePath) {
        sendText(res, 403, 'Accès refusé');
        return;
      }

      let info = await stat(filePath).catch(() => null);
      if (info && info.isDirectory()) {
        // Directories need a trailing slash so relative URLs (./js/app.js) resolve correctly.
        if (!url.pathname.endsWith('/')) {
          res.writeHead(301, { Location: `${url.pathname}/${url.search}`, 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        filePath = join(filePath, 'index.html');
        info = await stat(filePath).catch(() => null);
      }
      if (!info || !info.isFile()) {
        sendText(res, 404, 'Introuvable');
        return;
      }

      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const headers = {
        'Content-Type': mimeType(filePath),
        // Development: always revalidate, so edits show up on reload (304 when unchanged).
        'Cache-Control': 'no-cache',
        ETag: etag,
        'Last-Modified': info.mtime.toUTCString(),
        'X-Content-Type-Options': 'nosniff',
      };
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers);
        res.end();
        return;
      }

      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      const stream = createReadStream(filePath);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (err) {
      if (!res.headersSent) sendText(res, 500, 'Erreur serveur');
      else res.destroy();
      console.error(err);
    }
  };
}

/** IPv4 addresses of this machine on the local network (to open the app from a phone). */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const addr of list || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

/**
 * Starts the server. Resolves once it listens.
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string, close: () => Promise<void> }>}
 */
export function startServer({ port = 8080, host = '0.0.0.0', root = DEFAULT_ROOT } = {}) {
  const server = createServer(createHandler(root));
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      const actualPort = server.address().port;
      resolvePromise({
        server,
        port: actualPort,
        url: `http://localhost:${actualPort}/`,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
            server.closeAllConnections(); // do not wait for browsers' keep-alive sockets
          }),
      });
    });
  });
}

async function main() {
  const port = process.env.PORT === undefined || process.env.PORT === '' ? 8080 : Number(process.env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT invalide : ${process.env.PORT}`);
    process.exit(1);
  }
  const host = process.env.HOST || '0.0.0.0';

  let started;
  try {
    started = await startServer({ port, host });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Le port ${port} est déjà utilisé. Essaie par exemple : PORT=8081 npm start`);
    } else {
      console.error(err);
    }
    process.exit(1);
  }

  console.log(`Recto est servi depuis ${DEFAULT_ROOT}`);
  console.log(`  Sur cet ordinateur : ${started.url}`);
  if (host === '0.0.0.0' || host === '::') {
    for (const ip of lanAddresses()) console.log(`  Sur le Wi-Fi        : http://${ip}:${started.port}/`);
    console.log('  (via une adresse IP en http, le mode hors ligne et le micro sont indisponibles :');
    console.log('   le navigateur les réserve au HTTPS et à localhost)');
  }
  console.log('Ctrl+C pour arrêter.');

  const stop = () => started.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
