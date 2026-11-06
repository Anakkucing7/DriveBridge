import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { parseDriveLink, signTicket, verifyTicket, disposition } from '../lib/drive.mjs';
import inspect from '../api/inspect.mjs';
import download from '../api/download.mjs';

const id = 'abcdefghijklmnopqrstuv';
process.env.DOWNLOAD_TOKEN_SECRET = 'test-secret-at-least-thirty-two-characters-long';

test('accepts shared file links and preserves resource keys', () => {
  assert.deepEqual(parseDriveLink(' https://drive.google.com/file/d/' + id + '/view?resourcekey=0-abc '), { id, resourceKey: '0-abc' });
  assert.equal(parseDriveLink('https://drive.google.com/open?id=' + id).id, id);
  assert.equal(parseDriveLink('https://drive.google.com/uc?export=download&id=' + id).id, id);
  assert.equal(parseDriveLink('https://docs.google.com/document/d/' + id + '/edit').id, id);
});

test('rejects off-site URLs, credentials, folders, malformed IDs, and oversized input', () => {
  for (const value of [null, '', 'http://drive.google.com/file/d/' + id, 'https://evil.example/file/d/' + id,
    'https://drive.google.com.evil.example/file/d/' + id, 'https://drive.google.com@evil.example/file/d/' + id,
    'https://user@drive.google.com/file/d/' + id, 'https://drive.google.com:8443/file/d/' + id,
    'https://drive.google.com/drive/folders/' + id, 'https://drive.google.com/file/d/tiny/view',
    'https://drive.google.com/random?id=' + id, 'a'.repeat(2049),
    'https://drive.google.com/file/d/' + id + '/view?resourcekey=bad%2Fvalue']) {
    assert.throws(() => parseDriveLink(value), undefined, String(value));
  }
});

test('signed download tickets reject tampering and expire after ten minutes', () => {
  const ticket = signTicket({ id, resourceKey: '' }, 1000);
  assert.equal(verifyTicket(ticket, 1001).id, id);
  assert.throws(() => verifyTicket(ticket, 601000), { status: 410 });
  assert.throws(() => verifyTicket(ticket + '.extra', 1001), { status: 403 });
  assert.throws(() => verifyTicket('changed.' + ticket.split('.')[1], 1001), { status: 403 });
  assert.throws(() => verifyTicket(null), { status: 400 });
});

test('download names cannot inject headers or filesystem paths', () => {
  const header = disposition('résumé/"evil"\r\n.zip');
  assert.ok(!/[\r\n]/.test(header));
  assert.ok(header.includes('filename*=UTF-8'));
  assert.ok(header.includes('r%C3%A9sum%C3%A9'));
  assert.ok(!header.includes('/'));
});

test('HTTP flow: inspect, stream and resume with mocked Google; errors remain useful', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.GOOGLE_DRIVE_API_KEY = 'test-only';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SECRET_KEY;
  delete process.env.VERCEL;
  delete process.env.NODE_ENV;
  const data = Buffer.alloc(5 * 1024 * 1024, 42);
  let mode = 'public';
  let mediaCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (!String(url).startsWith('https://www.googleapis.com/')) return originalFetch(url, options);
    assert.equal(new URL(url).hostname, 'www.googleapis.com');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Goog-Drive-Resource-Keys'], id + '/0-abc');
    if (mode === 'private') return new Response('{}', { status: 404 });
    if (new URL(url).searchParams.has('alt')) {
      mediaCalls++;
      const partial = options.headers.Range === 'bytes=100-';
      return new Response(partial ? data.subarray(100) : data, { status: partial ? 206 : 200, headers: { 'content-length': String(partial ? data.length - 100 : data.length), ...(partial ? { 'content-range': 'bytes 100-' + (data.length - 1) + '/' + data.length } : {}) } });
    }
    return Response.json({ id, name: 'sample.zip', size: String(data.length), mimeType: mode === 'docs' ? 'application/vnd.google-apps.document' : 'application/zip', capabilities: { canDownload: mode !== 'blocked' } });
  };
  const server = http.createServer((req, res) => req.url.startsWith('/api/inspect') ? inspect(req, res) : download(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => { globalThis.fetch = originalFetch; process.env = originalEnv; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const post = body => originalFetch(base + '/api/inspect', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
  let response = await post({ url: 'https://drive.google.com/file/d/' + id + '/view?resourcekey=0-abc' });
  assert.equal(response.status, 200);
  const file = await response.json();
  assert.equal(file.size, data.length);
  assert.ok(!file.downloadUrl.includes('test-only'));
  response = await originalFetch(base + file.downloadUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.ok(response.headers.get('content-disposition').includes('sample.zip'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data);
  response = await originalFetch(base + file.downloadUrl, { headers: { Range: 'bytes=100-' } });
  assert.equal(response.status, 206);
  assert.ok(response.headers.get('content-range').startsWith('bytes 100-'));
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(100));
  response = await originalFetch(base + file.downloadUrl, { headers: { Range: 'bytes=1-2,3-4' } });
  assert.equal(response.status, 416);
  assert.match(await response.text(), /Kembali dan periksa file/);
  mode = 'private';
  response = await originalFetch(base + file.downloadUrl);
  assert.equal(response.status, 404);
  assert.equal(mediaCalls, 2, 'recheck permission before every download');
  mode = 'blocked';
  assert.equal((await post({ url: 'https://drive.google.com/file/d/' + id + '/view?resourcekey=0-abc' })).status, 403);
  mode = 'docs';
  assert.equal((await post({ url: 'https://drive.google.com/file/d/' + id + '/view?resourcekey=0-abc' })).status, 400);
  assert.equal((await post('{broken')).status, 400);
  assert.equal((await post('x'.repeat(5000))).status, 413);
  assert.equal((await originalFetch(base + '/api/inspect')).status, 405);
  mode = 'public';
  delete process.env.GOOGLE_DRIVE_API_KEY;
  assert.equal((await post({ url: 'https://drive.google.com/file/d/' + id })).status, 503);
  process.env.VERCEL = '1';
  assert.equal((await post({ url: 'https://drive.google.com/file/d/' + id })).status, 503, 'production fails closed without Supabase');
});

test('Supabase rate limiter uses server key and respects deny response', async () => {
  const { rateLimit } = await import('../lib/rate-limit.mjs');
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://example.supabase.co/rest/v1/rpc/drivebridge_consume_request');
      assert.equal(options.headers.apikey, 'sb_secret_test');
      const body = JSON.parse(options.body);
      assert.match(body.p_key, /^[a-f0-9]{64}$/);
      assert.equal(body.p_limit, 20);
      assert.ok(!options.body.includes('127.0.0.1'));
      return Response.json(false);
    };
    await assert.rejects(rateLimit({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, 'inspect'), { status: 429 });
    globalThis.fetch = async () => new Response('', { status: 500 });
    await assert.rejects(rateLimit({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }, 'inspect'), { status: 503 });
  } finally { globalThis.fetch = originalFetch; process.env = originalEnv; }
});

test('browser bundle avoids modern JavaScript syntax and external assets', async () => {
  const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /\b(?:const|let|async|await|import)\b|=>|\?\./);
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /(?:src|href)="https?:\/\//);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /<label for="drive-url">/);
});

