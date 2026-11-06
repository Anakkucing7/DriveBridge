import { createHmac, timingSafeEqual } from 'node:crypto';

export class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function parseDriveLink(input) {
  if (typeof input !== 'string' || input.length > 2048) throw new AppError(400, 'Masukkan tautan Google Drive yang valid.');
  let url;
  try { url = new URL(input.trim()); } catch { throw new AppError(400, 'Tautan belum lengkap. Salin tautan dari menu Bagikan di Google Drive.'); }
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(url.hostname) || url.port || url.username || url.password) {
    throw new AppError(400, 'Gunakan tautan HTTPS dari drive.google.com atau docs.google.com.');
  }
  if (/\/folders(?:\/|$)/.test(url.pathname)) throw new AppError(400, 'Folder belum didukung. Tempel tautan satu file di dalam folder.');
  const match = url.pathname.match(/^\/(?:file|document|spreadsheets|presentation)\/d\/([\w-]+)(?:\/|$)/);
  const id = match ? match[1] : ['/open', '/uc'].includes(url.pathname) ? url.searchParams.get('id') : null;
  const resourceKey = url.searchParams.get('resourcekey') || '';
  if (!id || !/^[\w-]{10,200}$/.test(id) || !/^[\w-]{0,200}$/.test(resourceKey)) throw new AppError(400, 'ID file tidak ditemukan. Gunakan tautan Bagikan untuk satu file Google Drive.');
  return { id, resourceKey };
}

function secret() {
  const value = process.env.DOWNLOAD_TOKEN_SECRET;
  if (!value || value.length < 32) throw new AppError(503, 'Layanan belum dikonfigurasi. Hubungi pengelola untuk mengaktifkan unduhan.');
  return value;
}
export function signTicket(file, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ id: file.id, resourceKey: file.resourceKey, expires: now + 10 * 60 * 1000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret()).update(payload).digest('base64url');
}
export function verifyTicket(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1500) throw new AppError(400, 'Tautan unduhan tidak valid. Periksa file kembali.');
  const [payload, signature, extra] = token.split('.');
  const expected = createHmac('sha256', secret()).update(payload || '').digest();
  const actual = Buffer.from(signature || '', 'base64url');
  if (extra || actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new AppError(403, 'Tautan unduhan tidak valid. Periksa file kembali.');
  let file;
  try { file = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw new AppError(400, 'Tautan unduhan tidak valid.'); }
  if (!Number.isFinite(file.expires) || file.expires <= now) throw new AppError(410, 'Tautan unduhan sudah kedaluwarsa. Periksa file kembali.');
  if (!/^[\w-]{10,200}$/.test(file.id) || typeof file.resourceKey !== 'string' || !/^[\w-]{0,200}$/.test(file.resourceKey)) throw new AppError(400, 'Tautan unduhan tidak valid.');
  return file;
}

export function driveRequest(file, { media = false, range, signal } = {}) {
  if (!process.env.GOOGLE_DRIVE_API_KEY) throw new AppError(503, 'Google Drive belum terhubung. Pengelola perlu mengisi API key di server.');
  const url = new URL('https://www.googleapis.com/drive/v3/files/' + file.id);
  url.searchParams.set('key', process.env.GOOGLE_DRIVE_API_KEY);
  if (media) url.searchParams.set('alt', 'media');
  else url.searchParams.set('fields', 'id,name,mimeType,size,capabilities(canDownload)');
  const headers = {};
  if (file.resourceKey) headers['X-Goog-Drive-Resource-Keys'] = file.id + '/' + file.resourceKey;
  if (range) headers.Range = range;
  // Never fetch a user-controlled URL or follow an upstream redirect.
  return fetch(url, { headers, redirect: 'error', signal: signal || AbortSignal.timeout(15000) });
}

export async function checkGoogleResponse(response) {
  if (response.ok) return;
  if (response.status === 404) throw new AppError(404, 'File tidak ditemukan atau belum dibagikan ke Siapa saja yang memiliki link.');
  if (response.status === 403 || response.status === 429) throw new AppError(response.status, 'File dibatasi, kuota Google habis, atau unduhan dinonaktifkan pemilik. Periksa izin berbagi atau coba lagi nanti.');
  if (response.status === 416) throw new AppError(416, 'Posisi unduhan tidak valid. Mulai ulang unduhan.');
  throw new AppError(502, 'Google Drive belum dapat dihubungi. Coba beberapa saat lagi.');
}

export async function getFile(file) {
  const response = await driveRequest(file);
  await checkGoogleResponse(response);
  const data = await response.json();
  if (String(data.mimeType).startsWith('application/vnd.google-apps.')) throw new AppError(400, 'Gunakan file biasa seperti ZIP, PDF, gambar, atau video. Folder dan dokumen Google belum didukung.');
  if (data.capabilities?.canDownload === false) throw new AppError(403, 'Pemilik file tidak mengizinkan unduhan.');
  if (typeof data.name !== 'string' || !/^\d+$/.test(String(data.size))) throw new AppError(502, 'Informasi file dari Google belum lengkap.');
  return { id: file.id, resourceKey: file.resourceKey, name: data.name, size: Number(data.size), mimeType: data.mimeType };
}

export function disposition(name) {
  const safe = name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'download';
  const ascii = safe.replace(/[^\x20-\x7e]|[";]/g, '_');
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(safe).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
}

