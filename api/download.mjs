import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, verifyTicket, getFile, driveRequest, checkGoogleResponse, disposition, downloadPlan, proxyAllowed, PROXY_MAX_BYTES, EXPORT_MAX_BYTES, DOWNLOAD_TIMEOUT_MS } from '../lib/drive.mjs';
import { errorResponse } from '../lib/http.mjs';
import { rateLimit, acquireProxy } from '../lib/rate-limit.mjs';

export default async function handler(req, res) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(new AppError(504, 'Mode kompatibel melewati batas 60 detik. Coba unduhan langsung atau file yang lebih kecil.')), DOWNLOAD_TIMEOUT_MS);
  let releaseProxy;
  const disconnect = () => { if (!res.writableFinished) abort.abort(); };
  res.on('close', disconnect);
  try {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new AppError(405, 'Gunakan metode GET.'); }
    const url = new URL(req.url, 'http://localhost');
    const mode = url.searchParams.get('mode');
    if (mode !== null && mode !== 'proxy') throw new AppError(400, 'Mode unduhan tidak valid.');
    const ticket = verifyTicket(url.searchParams.get('token'));
    await rateLimit(req, 'download');
    const file = await getFile(ticket, abort.signal);
    if (mode !== 'proxy') {
      const plan = await downloadPlan(file, abort.signal);
      if (plan.target) {
        res.statusCode = 302;
        res.setHeader('Location', plan.target);
        res.setHeader('Cache-Control', 'private, no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Download-Mode', plan.mode);
        return res.end();
      }
    }
    if (!proxyAllowed(file)) throw new AppError(413, 'Mode kompatibel hanya mendukung file sampai 25 MiB. Gunakan unduhan langsung untuk file besar.');
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : NaN;
      const end = match && match[2] ? Number(match[2]) : file.size - 1;
      if (file.exportMimeType || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= file.size) throw new AppError(416, 'Rentang unduhan tidak valid. Mulai ulang unduhan.');
    }
    releaseProxy = await acquireProxy();
    if (abort.signal.aborted) throw new AppError(504, 'Waktu permintaan habis. Coba periksa file kembali.');
    const response = await driveRequest(file, { media: true, range, signal: abort.signal });
    await checkGoogleResponse(response);
    const maxBytes = file.exportMimeType ? EXPORT_MAX_BYTES : PROXY_MAX_BYTES;
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new AppError(413, 'Ukuran transfer melebihi batas mode kompatibel. Gunakan unduhan langsung atau file yang lebih kecil.');
    }
    if (!response.body) throw new AppError(502, 'Google tidak mengirim isi file. Coba lagi nanti.');
    if (file.exportMimeType && !response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) { await response.body.cancel(); throw new AppError(502, 'Google tidak mengirim hasil ekspor PDF yang valid.'); }
    res.statusCode = response.status;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', disposition(file.name));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Download-Mode', 'proxy');
    if (!file.exportMimeType) res.setHeader('Accept-Ranges', 'bytes');
    for (const header of ['content-length', 'content-range']) if (response.headers.has(header)) res.setHeader(header, response.headers.get(header));
    let transferred = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      transferred += chunk.length;
      if (transferred > maxBytes) { abort.abort(); callback(new AppError(413, 'Transfer melebihi batas mode kompatibel.')); }
      else callback(null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, res, { signal: abort.signal });
  } catch (error) {
    abort.abort();
    if (res.headersSent) res.destroy();
    else if (!res.destroyed) errorResponse(res, abort.signal.reason instanceof AppError ? abort.signal.reason : error, true);
  } finally { clearTimeout(timeout); res.off('close', disconnect); releaseProxy?.(); }
}
