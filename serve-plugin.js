/**
 * Minimal static server for the built plugin.
 *
 * Replaces `npm run dev` for day-to-day use: no webpack, no file watching, no
 * node_modules - just Node built-ins serving ./dist. RemNote's
 * "Develop from localhost" loads the plugin from here.
 *
 * Rebuild with `npm run build` after changing source; this server always serves
 * whatever is currently in ./dist.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, 'dist');
const PORT = Number(process.env.PORT) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

http
  .createServer((req, res) => {
    // RemNote loads the plugin in a sandboxed iframe from a different origin.
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'baggage, sentry-trace');
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const rel = decodeURIComponent((req.url || '/').split('?')[0]);
    const file = path.join(ROOT, rel === '/' ? 'index.html' : rel);

    // Never serve outside dist/.
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    fs.readFile(file, (err, buf) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      });
      res.end(buf);
    });
  })
  .listen(PORT, '127.0.0.1', () => {
    console.log(`Academic Organizer served from ${ROOT} at http://localhost:${PORT}`);
  });
