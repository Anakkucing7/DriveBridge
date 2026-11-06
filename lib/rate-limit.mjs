import { createHmac } from 'node:crypto';
import { AppError } from './drive.mjs';

const local = new Map();
let activeProxies = 0;
async function consume(key, action, limit, minute) {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
    const response = await fetch(process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/rpc/drivebridge_consume_request', {
      method: 'POST',
      headers: { apikey: process.env.SUPABASE_SECRET_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_key: key, p_action: action, p_limit: limit }),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new AppError(503, 'Layanan sedang sibuk. Coba beberapa saat lagi.');
    const allowed = await response.json();
    if (allowed !== true) throw new AppError(429, 'Terlalu banyak permintaan. Tunggu satu menit, lalu coba lagi.');
    return;
  }
  // shortcut: in-memory limits are for local development; production requires Supabase.
  for (const [entry, value] of local) if (value.minute !== minute) local.delete(entry);
  const bucket = action + ':' + key;
  const count = (local.get(bucket)?.count || 0) + 1;
  local.set(bucket, { count, minute });
  if (count > limit) throw new AppError(429, 'Terlalu banyak permintaan. Tunggu satu menit, lalu coba lagi.');
}

export async function rateLimit(req, action) {
  const production = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  const ip = production ? req.headers['x-vercel-forwarded-for'] : req.socket?.remoteAddress;
  const secret = process.env.DOWNLOAD_TOKEN_SECRET;
  if (production && (!ip || !secret || !process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY)) throw new AppError(503, 'Layanan belum siap. Pengelola perlu melengkapi konfigurasi server.');
  const minute = Math.floor(Date.now() / 60000);
  const key = createHmac('sha256', secret || 'local-development-only').update(String(ip || 'local') + ':' + minute).digest('hex');
  await consume(key, action, action === 'inspect' ? 20 : 10, minute);
}

export async function acquireProxy() {
  if (activeProxies >= 2) throw new AppError(429, 'Mode kompatibel sedang penuh. Coba unduhan langsung atau ulangi sebentar lagi.');
  activeProxies++;
  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = createHmac('sha256', process.env.DOWNLOAD_TOKEN_SECRET || 'local-development-only').update('proxy-global:' + minute).digest('hex');
    // Existing atomic Supabase counter: at most six proxy starts per minute across instances.
    await consume(key, 'download', 6, minute);
    return () => { activeProxies--; };
  } catch (error) { activeProxies--; throw error; }
}
