import { AppError, parseDriveLink, getFile, signTicket } from '../lib/drive.mjs';
import { json, errorResponse } from '../lib/http.mjs';
import { rateLimit } from '../lib/rate-limit.mjs';

export default async function handler(req, res) {
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
    const file = await getFile(parseDriveLink(body?.url));
    const token = signTicket(file);
    json(res, 200, { name: file.name, size: file.size, mimeType: file.mimeType, downloadUrl: '/api/download?token=' + encodeURIComponent(token), expiresIn: 600 });
  } catch (error) { errorResponse(res, error); }
}

