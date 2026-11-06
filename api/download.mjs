import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, verifyTicket, getFile, driveRequest, checkGoogleResponse, disposition } from '../lib/drive.mjs';
import { errorResponse } from '../lib/http.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';

export default async function handler(req, res) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 285000);
  const disconnect = () => { if (!res.writableFinished) abort.abort(); };
  res.on('close', disconnect);
  try {
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); throw new AppError(405, 'Gunakan metode GET.'); }
    const url = new URL(req.url, 'http://localhost');
    const ticket = verifyTicket(url.searchParams.get('token'));
    await rateLimit(req, 'download');
    const file = await getFile(ticket);
    const range = req.headers.range;
    if (range && !/^bytes=\d+-\d*$/.test(range)) throw new AppError(416, 'Rentang unduhan tidak valid. Mulai ulang unduhan.');
    const response = await driveRequest(file, { media: true, range, signal: abort.signal });
    await checkGoogleResponse(response);
    res.statusCode = response.status;
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', disposition(file.name));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Accept-Ranges', 'bytes');
    for (const header of ['content-length', 'content-range']) if (response.headers.has(header)) res.setHeader(header, response.headers.get(header));
    // Stream to the browser's download manager; never buffer the file in browser RAM.
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (res.headersSent) res.destroy();
    else errorResponse(res, error, true);
  } finally { clearTimeout(timeout); res.off('close', disconnect); }
}

