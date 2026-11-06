import { AppError, parseDriveLink, getFile, signTicket, downloadPlan, proxyAllowed, PROXY_MAX_BYTES, EXPORT_MAX_BYTES } from '../lib/drive.mjs';
import { json, errorResponse } from '../lib/http.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';

export default async function handler(req, res) {
  const abort = new AbortController();
  const disconnect = () => { if (!res.writableFinished) abort.abort(); };
  res.on('close', disconnect);
  try {
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); throw new AppError(405, 'Gunakan metode POST.'); }
    await rateLimit(req, 'inspect');
    let body = req.body;
    if (!body) {
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > 4096) throw new AppError(413, 'Tautan terlalu panjang.');
      }
      try { body = JSON.parse(text); } catch { throw new AppError(400, 'Data permintaan tidak valid.'); }
    } else if (typeof body === 'string') {
      if (body.length > 4096) throw new AppError(413, 'Tautan terlalu panjang.');
      try { body = JSON.parse(body); } catch { throw new AppError(400, 'Data permintaan tidak valid.'); }
    }
    const file = await getFile(parseDriveLink(body?.url), abort.signal);
    const plan = await downloadPlan(file, abort.signal);
    const token = signTicket(file);
    const downloadUrl = '/api/download?token=' + encodeURIComponent(token);
    json(res, 200, { name: file.name, size: file.size, mimeType: file.mimeType, downloadMode: plan.mode, downloadUrl, fallbackUrl: plan.target && proxyAllowed(file) ? downloadUrl + '&mode=proxy' : null, proxyLimitBytes: file.exportMimeType ? EXPORT_MAX_BYTES : PROXY_MAX_BYTES, expiresIn: 600 });
  } catch (error) { if (!res.destroyed) errorResponse(res, error); }
  finally { res.off('close', disconnect); }
}
