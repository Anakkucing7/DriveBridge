import http from 'node:http';
import { readFile } from 'node:fs/promises';
import inspect from './api/inspect.mjs';
import download from './api/download.mjs';

const files = { '/': ['index.html', 'text/html'], '/styles.css': ['styles.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'], '/sample.svg': ['sample.svg', 'image/svg+xml'] };
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if (path === '/api/inspect') return inspect(req, res);
  if (path === '/api/download') return download(req, res);
  if (!files[path] || req.method !== 'GET') { res.writeHead(404); return res.end('Not found'); }
  try {
    res.setHeader('Content-Type', files[path][1] + '; charset=utf-8');
    res.end(await readFile(new URL('./public/' + files[path][0], import.meta.url)));
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.listen(Number(process.env.PORT) || 3000, '127.0.0.1', () => console.log('DriveBridge: http://127.0.0.1:' + server.address().port));

