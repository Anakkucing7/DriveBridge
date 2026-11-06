import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import inspect from '../api/inspect.mjs';
import download from '../api/download.mjs';
import { PROXY_MAX_BYTES, EXPORT_MAX_BYTES, DOWNLOAD_TIMEOUT_MS } from '../lib/drive.mjs';

const id = 'public_binary_file_123456';
const url = 'https://drive.google.com/file/d/' + id + '/view';
const browserLink = 'https://drive.google.com/uc?id=' + id + '&export=download';
const binary = (extra = {}) => ({ id, name: 'archive.zip', mimeType: 'application/zip', size: '1024', capabilities: { canDownload: true }, webContentLink: browserLink, ...extra });
const attachment = () => new Response(null, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="archive.zip"' } });

async function app(t, config = {}) {
  const realFetch = globalThis.fetch;
  const env = { ...process.env };
  Object.assign(process.env, { GOOGLE_DRIVE_API_KEY: 'server-only-google-key', DOWNLOAD_TOKEN_SECRET: 'test-signing-secret-at-least-thirty-two-characters', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_test' });
  delete process.env.VERCEL;
  delete process.env.NODE_ENV;
  const calls = { metadata: [], head: [], media: [], rate: [] };
  globalThis.fetch = async (target, options = {}) => {
    const parsed = new URL(target);
    if (parsed.hostname === 'example.supabase.co') {
      assert.equal(options.headers.apikey, 'sb_secret_test');
      const body = JSON.parse(options.body);
      calls.rate.push(body);
      return Response.json(config.rate ? config.rate(body) : true);
    }
    if (parsed.hostname === 'www.googleapis.com') {
      assert.equal(options.redirect, 'error');
      if (parsed.searchParams.get('alt') === 'media' || parsed.pathname.endsWith('/export')) {
        calls.media.push({ url: parsed, options });
        return config.media ? config.media(parsed, options) : new Response(Buffer.alloc(1024, 42));
      }
      calls.metadata.push({ url: parsed, options });
      return config.metadata ? config.metadata(parsed, options) : Response.json(binary(config.file));
    }
    if (options.method === 'HEAD') {
      calls.head.push({ url: parsed, options });
      assert.equal(options.headers, undefined, 'anonymous probe must not forward credentials or cookies');
      assert.equal(options.redirect, 'manual');
      assert.ok(!String(target).includes('server-only-google-key'));
      return config.head ? config.head(parsed, options) : attachment();
    }
    throw new Error('Unexpected outbound fetch: ' + parsed.origin);
  };
  const server = http.createServer((req, res) => req.url.startsWith('/api/inspect') ? inspect(req, res) : download(req, res));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch;
    process.env = env;
  });
  return {
    calls, base,
    inspect: (link = url) => realFetch(base + '/api/inspect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: link }) }),
    download: (path, options = {}) => realFetch(base + path, { redirect: 'manual', ...options })
  };
}

test('public and anyone-with-link binaries use a credential-free redirect, never a media GET', async t => {
  const api = await app(t);
  const inspected = await api.inspect();
  assert.equal(inspected.status, 200);
  const file = await inspected.json();
  assert.equal(file.downloadMode, 'direct');
  assert.ok(file.fallbackUrl.endsWith('&mode=proxy'));
  const response = await api.download(file.downloadUrl);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), browserLink);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  assert.equal(api.calls.media.length, 0, 'no file bytes requested by Vercel');
  assert.equal(api.calls.head.length, 2);
  assert.equal(api.calls.rate.filter(call => call.p_action === 'download').length, 1);
  assert.doesNotMatch(JSON.stringify(file) + response.headers.get('location'), /server-only-google-key|sb_secret_test|www\.googleapis\.com/);
});

test('resource keys survive API headers, signed tickets, anonymous probes and browser redirects', async t => {
  const api = await app(t, { file: { resourceKey: '0-resource-key' } });
  const file = await (await api.inspect(url + '?resourcekey=0-resource-key')).json();
  const response = await api.download(file.downloadUrl);
  assert.equal(new URL(response.headers.get('location')).searchParams.get('resourcekey'), '0-resource-key');
  for (const call of api.calls.metadata) assert.equal(call.options.headers['X-Goog-Drive-Resource-Keys'], id + '/0-resource-key');
  for (const call of api.calls.head) assert.equal(call.url.searchParams.get('resourcekey'), '0-resource-key');
});

test('large binaries can redirect but cannot force proxy bandwidth through a mode query', async t => {
  const api = await app(t, { file: { size: String(5 * 1024 ** 3) } });
  const file = await (await api.inspect()).json();
  assert.equal(file.downloadMode, 'direct');
  assert.equal(file.fallbackUrl, null);
  assert.equal((await api.download(file.downloadUrl)).status, 302);
  assert.equal((await api.download(file.downloadUrl + '&mode=proxy')).status, 413);
  assert.equal(api.calls.media.length, 0);
  assert.equal(api.calls.rate.filter(call => call.p_limit === 6).length, 0);
});

test('backend metadata access alone is insufficient: failed anonymous probe cannot redirect', async t => {
  const api = await app(t, { head: () => new Response(null, { status: 403 }) });
  const file = await (await api.inspect()).json();
  assert.equal(file.downloadMode, 'proxy');
  assert.equal(file.fallbackUrl, null);
  const response = await api.download(file.downloadUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-download-mode'), 'proxy');
  assert.equal((await response.arrayBuffer()).byteLength, 1024);
});

test('large files without a verified anonymous download receive an explanation, not a forced redirect', async t => {
  const api = await app(t, { file: { size: String(PROXY_MAX_BYTES + 1) }, head: () => new Response(null, { headers: { 'content-type': 'text/html' } }) });
  const response = await api.inspect();
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /25 MiB/);
  assert.equal(api.calls.media.length, 0);
});

for (const [kind, mime, path] of [
  ['Docs', 'document', '/document/d/' + id + '/export?format=pdf'],
  ['Sheets', 'spreadsheet', '/spreadsheets/d/' + id + '/export?format=pdf'],
  ['Slides', 'presentation', '/presentation/d/' + id + '/export/pdf']
]) {
  test(kind + ' uses the official PDF export link when anonymously downloadable', async t => {
    const target = 'https://docs.google.com' + path;
    const api = await app(t, { file: { mimeType: 'application/vnd.google-apps.' + mime, size: undefined, name: 'Document', exportLinks: { 'application/pdf': target } } });
    const file = await (await api.inspect('https://docs.google.com/' + (kind === 'Docs' ? 'document' : kind === 'Sheets' ? 'spreadsheets' : 'presentation') + '/d/' + id + '/edit')).json();
    assert.equal(file.downloadMode, 'export');
    assert.equal(file.mimeType, 'application/pdf');
    assert.equal(file.name, 'Document.pdf');
    assert.equal(file.size, null);
    assert.equal(file.proxyLimitBytes, EXPORT_MAX_BYTES);
    const response = await api.download(file.downloadUrl);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), target);
    assert.equal(api.calls.media.length, 0);
  });
}

test('Workspace fallback uses files.export with PDF MIME type, streams and disallows Range', async t => {
  const bytes = Buffer.from('%PDF-1.7\nexample');
  const api = await app(t, {
    file: { mimeType: 'application/vnd.google-apps.document', size: undefined, exportLinks: undefined },
    media: (target, options) => {
      assert.ok(target.pathname.endsWith('/' + id + '/export'));
      assert.equal(target.searchParams.get('mimeType'), 'application/pdf');
      assert.equal(target.searchParams.has('alt'), false);
      assert.equal(options.headers.Authorization, undefined);
      return new Response(bytes, { headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.length) } });
    }
  });
  const file = await (await api.inspect()).json();
  assert.equal(file.downloadMode, 'proxy');
  const response = await api.download(file.downloadUrl);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.has('accept-ranges'), false);
  assert.match(response.headers.get('content-disposition'), /archive.zip.pdf/);
  assert.equal((await api.download(file.downloadUrl, { headers: { Range: 'bytes=0-1' } })).status, 416);
});

test('explicit compatibility fallback bypasses browser probing, keeps size and Range checks', async t => {
  const api = await app(t, { media: (target, options) => {
    assert.equal(options.headers.Range, 'bytes=100-199');
    return new Response(Buffer.alloc(100, 42), { status: 206, headers: { 'content-range': 'bytes 100-199/1024', 'content-length': '100' } });
  } });
  const file = await (await api.inspect()).json();
  const response = await api.download(file.fallbackUrl, { headers: { Range: 'bytes=100-199' } });
  assert.equal(response.status, 206);
  assert.equal((await response.arrayBuffer()).byteLength, 100);
  assert.equal(api.calls.head.length, 1, 'explicit fallback should not repeat browser probe');
  for (const range of ['bytes=1-2,3-4', 'bytes=-10', 'bytes=900-100', 'bytes=0-1024', 'bytes=999999999999999999999-']) assert.equal((await api.download(file.fallbackUrl, { headers: { Range: range } })).status, 416);
  assert.equal(api.calls.media.length, 1);
});

for (const [name, metadata, status] of [
  ['private', () => Response.json({ error: {} }, { status: 404 }), 404],
  ['restricted', () => Response.json(binary({ capabilities: { canDownload: false } })), 403],
  ['unverified capability', () => Response.json(binary({ capabilities: {} })), 403],
  ['folder', () => Response.json(binary({ mimeType: 'application/vnd.google-apps.folder' })), 400],
  ['unsafe size', () => Response.json(binary({ size: '9007199254740992' })), 502],
  ['quota', () => Response.json({ error: { errors: [{ reason: 'downloadQuotaExceeded' }] } }, { status: 403 }), 429],
  ['malware', () => Response.json({ error: { errors: [{ reason: 'cannotDownloadAbusiveFile' }] } }, { status: 403 }), 403],
  ['permission error', () => Response.json({ error: { message: 'server-only-google-key', errors: [{ reason: 'insufficientFilePermissions' }] } }, { status: 403 }), 403]
]) {
  test(name + ' cannot obtain a download ticket or trigger a media request', async t => {
    const api = await app(t, { metadata });
    const response = await api.inspect();
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /server-only-google-key|sb_secret_test/);
    assert.equal(api.calls.media.length, 0);
    assert.equal(api.calls.head.length, 0);
  });
}

test('permission is rechecked at download time before redirecting a previously allowed file', async t => {
  let revoked = false;
  const api = await app(t, { metadata: () => revoked ? Response.json({ error: {} }, { status: 404 }) : Response.json(binary()) });
  const file = await (await api.inspect()).json();
  revoked = true;
  const response = await api.download(file.downloadUrl);
  assert.equal(response.status, 404);
  assert.equal(response.headers.has('location'), false);
  assert.equal(api.calls.head.length, 1);
});

test('SSRF targets, unrelated IDs, ports and credentials in metadata are never probed or redirected', async t => {
  let target;
  const api = await app(t, { metadata: () => Response.json(binary({ webContentLink: target })) });
  for (target of [
    'http://127.0.0.1/private', 'https://drive.google.com.evil.example/uc?id=' + id,
    'https://user:password@drive.google.com/uc?id=' + id, 'https://drive.google.com:8443/uc?id=' + id,
    'https://drive.google.com/uc?id=some_other_file_123', browserLink + '&access_token=private-token',
    browserLink + '&key=server-only-google-key', browserLink + '&client_secret=private-secret',
    browserLink + '&refresh_token=private-token', browserLink + '&redirect_uri=https://evil.example',
    browserLink + '&unexpected=server-only-google-key', browserLink + '&confirm=malware-bypass',
    'https://www.googleapis.com/drive/v3/files/' + id
  ]) {
    const response = await api.inspect();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).downloadMode, 'proxy');
  }
  assert.equal(api.calls.head.length, 0);
});

test('anonymous redirect chain may reach Google content hosts but cannot follow an external redirect', async t => {
  let hostile = false;
  const api = await app(t, { head: target => {
    if (target.hostname === 'drive.google.com') return new Response(null, { status: 302, headers: { location: hostile ? 'http://127.0.0.1/internal' : 'https://doc-1-docs.googleusercontent.com/download' } });
    assert.equal(target.hostname, 'doc-1-docs.googleusercontent.com');
    return attachment();
  } });
  assert.equal((await (await api.inspect()).json()).downloadMode, 'direct');
  hostile = true;
  assert.equal((await (await api.inspect()).json()).downloadMode, 'proxy');
  assert.equal(api.calls.head.length, 3);
});

test('invalid/missing IDs and modes cannot trigger arbitrary upstream requests', async t => {
  const api = await app(t);
  for (const value of ['', 'https://drive.google.com/file/d/short/view', 'https://example.com/file/d/' + id]) assert.equal((await api.inspect(value)).status, 400);
  assert.equal((await api.download('/api/download')).status, 400);
  assert.equal((await api.download('/api/download?mode=unknown')).status, 400);
  assert.equal(api.calls.metadata.length, 0);
});

test('rate limits apply before direct redirects; fallback also consumes the shared proxy budget', async t => {
  let denyDownloads = false;
  const api = await app(t, { rate: body => body.p_limit !== 6 && !(denyDownloads && body.p_action === 'download') });
  const file = await (await api.inspect()).json();
  const response = await api.download(file.fallbackUrl);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.equal(api.calls.media.length, 0);
  denyDownloads = true;
  assert.equal((await api.download(file.downloadUrl)).status, 429);
  assert.equal(api.calls.head.length, 1);
});

test('fallback rejects oversized Content-Length and cancels upstream before sending file headers', async t => {
  let cancelled = false;
  const api = await app(t, { media: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(PROXY_MAX_BYTES + 1) } }) });
  const file = await (await api.inspect()).json();
  const response = await api.download(file.fallbackUrl);
  assert.equal(response.status, 413);
  assert.equal(response.headers.has('content-disposition'), false);
  assert.equal(cancelled, true);
});

test('unknown-length oversized transfer is cut off at the byte cap and cancelled', async t => {
  let cancelled = false;
  let chunks = 0;
  const api = await app(t, { media: () => new Response(new ReadableStream({
    pull(controller) { chunks++; controller.enqueue(Buffer.alloc(1024 * 1024)); },
    cancel() { cancelled = true; }
  })) });
  const file = await (await api.inspect()).json();
  const response = await api.download(file.fallbackUrl);
  let received = 0;
  const reader = response.body.getReader();
  await assert.rejects(async () => { while (true) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; } });
  assert.ok(received <= PROXY_MAX_BYTES);
  assert.equal(cancelled, true);
  assert.ok(chunks < 35, 'upstream reading must stop rather than drain the entire source');
});

test('exports respect both Google 10 MB errors and the local byte cap', async t => {
  let quotaError = true;
  const api = await app(t, {
    file: { mimeType: 'application/vnd.google-apps.spreadsheet', exportLinks: undefined },
    media: () => quotaError ? Response.json({ error: { errors: [{ reason: 'exportSizeLimitExceeded' }] } }, { status: 403 }) : new Response(null, { headers: { 'content-type': 'application/pdf', 'content-length': String(EXPORT_MAX_BYTES + 1) } })
  });
  const file = await (await api.inspect()).json();
  assert.equal((await api.download(file.downloadUrl)).status, 413);
  quotaError = false;
  assert.equal((await api.download(file.downloadUrl)).status, 413);
});

test('proxy duration deadline aborts a stalled request and releases its slot', async t => {
  const realTimer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => realTimer(callback, ms === DOWNLOAD_TIMEOUT_MS ? 20 : ms, ...args));
  const api = await app(t, { media: (target, { signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }) });
  const file = await (await api.inspect()).json();
  const response = await api.download(file.fallbackUrl);
  assert.equal(response.status, 504);
  assert.match(await response.text(), /60 detik/);
});

test('proxy concurrency is bounded and client cancellation releases both upstream streams', async t => {
  let cancelled = 0;
  let hold = true;
  const api = await app(t, { media: () => hold ? new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from('x')); }, cancel() { cancelled++; } })) : new Response('done') });
  const file = await (await api.inspect()).json();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const first = await api.download(file.fallbackUrl, { signal: firstAbort.signal });
  const second = await api.download(file.fallbackUrl, { signal: secondAbort.signal });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal((await api.download(file.fallbackUrl)).status, 429);
  firstAbort.abort(); secondAbort.abort();
  for (let attempt = 0; attempt < 100 && cancelled < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cancelled, 2);
  hold = false;
  const retry = await api.download(file.fallbackUrl);
  assert.equal(await retry.text(), 'done');
});

test('existing Supabase RPC enforces the same six-start budget across proxy instances', async t => {
  const counts = new Map();
  const api = await app(t, { rate: body => {
    const count = (counts.get(body.p_key) || 0) + 1;
    counts.set(body.p_key, count);
    return count <= body.p_limit;
  } });
  t.mock.method(Date, 'now', () => 120000);
  const first = await import('../lib/rate-limit.mjs?instance=first');
  const second = await import('../lib/rate-limit.mjs?instance=second');
  for (let i = 0; i < 6; i++) { const release = await (i % 2 ? first : second).acquireProxy(); release(); }
  await assert.rejects(first.acquireProxy(), { status: 429 });
  assert.equal(api.calls.rate.length, 7);
  assert.equal(new Set(api.calls.rate.map(call => call.p_key)).size, 1);
  assert.ok(api.calls.rate.every(call => call.p_limit === 6 && call.p_action === 'download'));
});
